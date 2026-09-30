# Reads the player's rivens out of Warframe's memory, read-only.
#
#   riven-scan.ps1 -Out riven-memory.json [-MaxSeconds 90] [-Regions all|nost|image]
#
# WHY THIS IS A REWRITE OF riven-memory.ps1
# ----------------------------------------
# The first version managed about 14 MB/s, which is 4.2 GB in five minutes. Two things
# dominated, and neither was the memory read:
#
#   1. It converted every 4 MB chunk into a .NET string and ran a compiled Regex over it.
#      That is 4.2 billion characters of string allocation plus a regex engine walk, and
#      the strings are almost entirely binary that can never match. Replacing both with a
#      direct byte scan for the two literal bytes that begin every trailer is the whole
#      win.
#   2. It read the executable's own code and read-only data (MEM_IMAGE), which is the
#      game's instructions, not its state. Skipping that is free and safe.
#
# Everything else here is the same idea as the working version: anchor on the mastery
# rank and weapon class that end every riven summary, walk back to the previous NUL for
# the exact start of the string, require real stat lines, and deduplicate by content
# because each riven is stored several times.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$ProcessName = 'Warframe.x64',
  # Stop once this many distinct rivens are found. Rivens are stored repeatedly, so the
  # count converges long before the whole address space has been walked.
  [int]$StopAfter = 60,
  # Hard wall-clock budget. A scan that has not answered by now is not going to, and
  # the app needs an answer in seconds, not minutes.
  [int]$MaxSeconds = 90,
  [ValidateSet('all', 'nost', 'image')][string]$Regions = 'nost',
  # Remembers which regions actually held rivens, so later scans start there instead of
  # rediscovering them. Costs one full walk once, then almost nothing.
  [string]$Cache = '',
  # Throw the memory away and walk the whole space again. Needed after a restart if the
  # first scan found few or no rivens, since a thin result poisons the memory.
  [switch]$RebuildCache,
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class RivenScan {
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI {
    public IntPtr BaseAddress;
    public IntPtr AllocationBase;
    public uint AllocationProtect;
    public ushort PartitionId;
    public UIntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, IntPtr len);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);

  public class Found { public string Address; public string Text; }
  public class Reg { public long Start; public long Size; public uint Type; public uint Protect; }

  // long, not int. A full walk reads past 3.5 GB, which wraps a signed 32-bit counter
  // into a negative number and made the app report "-327 MB read at -15.6 MB/s".
  public static long BytesRead = 0;
  public static int RegionsRead = 0;
  public static long RegionsSkipped = 0;
  // Rivens refused because a stat had no sign and so could not be told apart from a
  // penalty. Surfaced rather than swallowed: a silently missing riven is worse than a
  // reported one.
  public static long AmbiguousSkipped = 0;
  // How many remembered regions this scan started from. Zero means there was no cache
  // yet and the whole space was walked, which only has to happen once.
  public static int CachedRegionsUsed = 0;

  const uint MEM_COMMIT = 0x1000;
  const uint MEM_IMAGE = 0x1000000;
  const int CHUNK = 8 * 1024 * 1024;
  const int MAX_STRING = 2048;
  const int TOOLS = 60;

  static bool IsSpace(byte b) { return b == 32 || b == 9 || b == 10 || b == 13 || b == 11 || b == 12 || b == 0xA0; }
  static bool IsDigit(byte b) { return b >= 48 && b <= 57; }
  // Char overload: Trim works on decoded text, so it has chars where the byte scanners
  // have bytes, and C# will not narrow implicitly.
  static bool IsDigit(char c) { return c >= '0' && c <= '9'; }
  static bool IsLetter(byte b) { return (b >= 65 && b <= 90) || (b >= 97 && b <= 122); }
  static byte Lower(byte b) { return (byte)(b | 0x20); }

  public static List<Reg> Regions(int pid) {
    var list = new List<Reg>();
    IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
    if (h == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try {
      int mbiSize = Marshal.SizeOf(typeof(MBI));
      long max = 0x00007FFFFFFFFFFF, addr = 0;
      while (addr < max) {
        MBI m;
        if (VirtualQueryEx(h, (IntPtr)addr, out m, (IntPtr)mbiSize) == IntPtr.Zero) break;
        long start = m.BaseAddress.ToInt64();
        long size = (long)m.RegionSize.ToUInt64();
        if (size <= 0) break;
        if (m.State == MEM_COMMIT && (m.Protect & 0x01) == 0 && (m.Protect & 0x100) == 0) {
          list.Add(new Reg { Start = start, Size = size, Type = m.Type, Protect = m.Protect });
        }
        addr = start + size;
      }
    } finally { CloseHandle(h); }
    return list;
  }

  /* Validates the trailer by hand: [mM][rR], up to three spaces, one or two digits, one
   * to four spaces, then three to fourteen letters. A compiled Regex over four gigabytes
   * of binary was the bottleneck; this is a handful of comparisons per candidate. */
  static int TrailerEnd(byte[] b, int len, int i) {
    if (i + 6 >= len) return -1;
    if (Lower(b[i]) != (byte)'m' || Lower(b[i + 1]) != (byte)'r') return -1;
    int j = i + 2, spaces = 0;
    while (j < len && IsSpace(b[j]) && spaces < 3) { j++; spaces++; }
    int digits = 0;
    while (j < len && IsDigit(b[j]) && digits < 2) { j++; digits++; }
    if (digits == 0) return -1;
    spaces = 0;
    while (j < len && IsSpace(b[j]) && spaces < 4) { j++; spaces++; }
    if (spaces == 0) return -1;
    int letters = 0;
    while (j < len && IsLetter(b[j]) && letters < 14) { j++; letters++; }
    return letters >= 3 ? j : -1;
  }

  /* Counts stat lines in a window: a signed number with a percent, or an xN.NN
   * multiplier. Byte-based for the same reason as above. */
  static int CountStats(byte[] b, int from, int to) {
    int count = 0;
    for (int i = from; i < to - 1; i++) {
      if (b[i] != (byte)'+' && b[i] != (byte)'-') continue;
      int j = i + 1, digits = 0;
      while (j < to && IsDigit(b[j]) && digits < 4) { j++; digits++; }
      if (digits == 0) continue;
      if (j < to && b[j] == (byte)'.') {
        j++;
        while (j < to && IsDigit(b[j])) j++;
      }
      if (j < to && b[j] == (byte)'%') { count++; i = j; }
    }
    return count;
  }

  static bool HasMultiplier(byte[] b, int from, int to) {
    for (int i = from; i < to - 1; i++) {
      if (Lower(b[i]) != (byte)'x') continue;
      int j = i + 1;
      if (j >= to || !IsDigit(b[j])) continue;
      j++;
      if (j >= to || b[j] != (byte)'.') continue;
      j++;
      int d = 0;
      while (j < to && IsDigit(b[j])) { j++; d++; }
      if (d > 0) return true;
    }
    return false;
  }

  static string Clean(byte[] b, int from, int to) {
    var sb = new StringBuilder(to - from);
    for (int i = from; i < to; i++) {
      byte c = b[i];
      // Drop UTF-8 debris in front of a stat name. Latin-1 turns those three bytes into
      // three characters, and the game stores them, e.g. "+84.1% e-electricity".
      sb.Append(c < 0x80 ? (char)c : ' ');
    }
    string s = sb.ToString();
    while (s.Contains("  ")) s = s.Replace("  ", " ");
    return s.Trim();
  }

  static string Normalise(string s) {
    var sb = new StringBuilder(s.Length);
    bool space = false;
    foreach (char c in s.ToLowerInvariant()) {
      if (char.IsWhiteSpace(c)) { space = true; continue; }
      if (space && sb.Length > 0) sb.Append(' ');
      space = false;
      sb.Append(c);
    }
    return sb.ToString();
  }

  /* Keeps the riven: from the weapon name through the trailer, dropping the heap noise
   * that sits either side of the string. */
  static string Trim(byte[] b, int from, int to) {
    string text = Clean(b, from, to);
    string[] lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
    var kept = new List<string>();
    bool started = false;
    foreach (string raw in lines) {
      string line = raw.Trim();
      if (line.Length == 0) { if (started) break; else continue; }
      bool looksStat = line.IndexOf('%') > 0 || line.IndexOf("%", StringComparison.Ordinal) > 0
        || (line.Length > 3 && (line[0] == '+' || line[0] == '-') && IsDigit(line[1]))
        || (line.Length > 3 && (line[0] == 'x' || line[0] == 'X') && IsDigit(line[1]));
        if (!started && looksStat) {
          started = true;
          int cut = -1;
          for (int i = 1; i < line.Length; i++) {
            if ((line[i] == '+' || line[i] == '-') && i + 1 < line.Length && IsDigit((byte)line[i + 1])) { cut = i; break; }
            if ((line[i] == 'x' || line[i] == 'X') && i + 1 < line.Length && IsDigit((byte)line[i + 1])
                && i + 2 < line.Length && line[i + 2] == '.') { cut = i; break; }
          }
          // A line can be the riven name with the first stat already glued to it, which
          // is what happens when the sign is missing: "pyrana sati zetisus 75.5% weapon
          // recoil" carries no sign, so nothing above matched and the whole line was
          // taken as the name. Cut at the number instead.
          if (cut < 0) {
            for (int i = 1; i < line.Length; i++) {
              if (IsDigit((byte)line[i]) && !IsDigit((byte)line[i - 1])) { cut = i; break; }
            }
          }
          if (cut > 0) {

          string name = line.Substring(0, cut).Trim();
          if (name.Length > 0) kept.Add(name);
          string rest = line.Substring(cut).Trim();
          if (rest.Length > 0) kept.Add(rest);
        } else kept.Add(line);
        continue;
      }
      if (started) kept.Add(line);
    }
    return string.Join("\n", kept.ToArray()).Trim();
  }

  /* Finds the region that contains an address, by binary search over a region list
   * sorted by start address. Used to remember which regions are worth reading again
   * instead of rediscovering them every scan. */
  public static long RegionStartFor(long addr) {
    int lo = 0, hi = AllByStart.Count - 1, best = -1;
    while (lo <= hi) {
      int mid = (int)((lo + hi) / 2);
      if (AllByStart[mid].Start <= addr) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best < 0) return -1;
    long end = AllByStart[best].Start + AllByStart[best].Size;
    return addr < end ? AllByStart[best].Start : -1;
  }

  public static List<Reg> AllByStart = new List<Reg>();

  /* True when the block opens with something that reads as a weapon name: letters and
   * spaces, at least two words, and no leading number or symbol. */
  static bool StartsWithName(string block) {
    int nl = block.IndexOf('\n');
    string first = (nl > 0 ? block.Substring(0, nl) : block).Trim();
    if (first.Length < 4) return false;
    if (!IsLetter((byte)first[0])) return false;

    // Counted by counting runs of letters, and any non-letter ends a run. Treating a
    // space as "still inside the word" counted "Sobek Acri-Vexidra" as one word and
    // rejected almost every real riven.
    int words = 0;
    bool inWord = false;
    for (int i = 0; i < first.Length; i++) {
      if (IsLetter((byte)first[i])) {
        if (!inWord) { inWord = true; words++; }
      } else {
        inWord = false;
      }
    }
    return words >= 2;
  }

  public static long NamelessSkipped = 0;

  /* Every stat line must carry an explicit sign.
   *
   * The game keeps each riven in memory twice. One copy is lower case and one is title
   * case, and they are not equally faithful: measured across a live collection, the
   * lower-case copy had 113 signed positives and not a single negative, while the
   * title-case copy had 15 real negatives. The lower-case copy simply drops the minus.
   *
   * That makes it unusable. "-7s Combo Duration" read as "7s combo duration" turns a
   * penalty into a bonus and grades the riven as far better than it is, which is the
   * one thing this reader must never do. A block with an unprefixed number is therefore
   * rejected rather than guessed at, and the count is reported so a missing riven is
   * visible instead of silent. */
  static bool AllStatsSigned(byte[] b, int from, int to) {
    for (int i = from; i < to; i++) {
      // Both bytes folded: the trailer is written "MR 13", and comparing only the
      // second one to a lower case 'r' while testing the first against a lower case
      // 'm' means it never matches, and the rank digits then look like unsigned stats.
      if (Lower(b[i]) == (byte)'m' && i + 8 < to && Lower(b[i + 1]) == (byte)'r') break; // trailer
      if (!IsDigit(b[i])) continue;
      if (i == from) continue;
      byte prev = b[i - 1];
      // "+12.5%" or "-0.3", and "x1.04" which is a multiplier rather than a bonus.
      if (prev == (byte)'+' || prev == (byte)'-' || prev == (byte)'x' || prev == (byte)'X') continue;
      // A further digit of the same number, and the fraction of a decimal. Without the
      // decimal point case every "+72.1%" was refused, because the 1 is preceded by a
      // full stop and that is neither a sign nor another digit.
      if (IsDigit(prev) || prev == (byte)'.') continue;
      return false;
    }
    return true;
  }

  static List<Found> refused = new List<Found>();
  public static List<Found> Refused { get { return refused; } }

  public static List<Found> Run(int pid, int stopAfter, int maxSeconds, string regionMode, long[] preferredStarts) {
    var found = new List<Found>();
    var seen = new HashSet<string>();
    var watch = Stopwatch.StartNew();
    IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
    if (h == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try {
      int mbiSize = Marshal.SizeOf(typeof(MBI));
      byte[] buf = new byte[CHUNK + MAX_STRING + TOOLS];
      long max = 0x00007FFFFFFFFFFF, addr = 0;
      var order = new List<Reg>();
      while (addr < max) {
        MBI m;
        if (VirtualQueryEx(h, (IntPtr)addr, out m, (IntPtr)mbiSize) == IntPtr.Zero) break;
        long start = m.BaseAddress.ToInt64();
        long size = (long)m.RegionSize.ToUInt64();
        if (size <= 0) break;
        if (m.State == MEM_COMMIT && (m.Protect & 0x01) == 0 && (m.Protect & 0x100) == 0) {
          order.Add(new Reg { Start = start, Size = size, Type = m.Type, Protect = m.Protect });
        }
        addr = start + size;
      }

      // Kept in address order for lookups, because the reading order below is by size
      // and the two have to be reconciled when a hit is turned back into a region.
      AllByStart = new List<Reg>(order);
      AllByStart.Sort(delegate(Reg a, Reg b) { return a.Start.CompareTo(b.Start); });

      // Regions previously proven to hold rivens go first. A repeat scan then costs the
      // same as reading a few hundred megabytes rather than the whole address space,
      // which is the difference between instant and a visible pause.
      var regions = new List<Reg>();
      if (preferredStarts != null && preferredStarts.Length > 0) {
        var preferred = new HashSet<long>(preferredStarts);
        for (int i = 0; i < order.Count; i++) if (preferred.Contains(order[i].Start)) regions.Add(order[i]);
        CachedRegionsUsed = regions.Count;
        for (int i = 0; i < order.Count; i++) if (!preferred.Contains(order[i].Start)) regions.Add(order[i]);
      } else {
        // Otherwise smallest first. The address space is mostly a few enormous
        // allocations, and the small private heaps are where string data lives, so this
        // finds the collection long before touching the giants and hits the stopping
        // count. Address order would read all of it first.
        regions.AddRange(order);
        regions.Sort(delegate(Reg a, Reg b) { return a.Size.CompareTo(b.Size); });
      }

      for (int ri = 0; ri < regions.Count; ri++) {
        if (found.Count >= stopAfter || watch.Elapsed.TotalSeconds >= maxSeconds) break;
        Reg r = regions[ri];
        long start = r.Start, size = r.Size;

        bool readable = (r.Protect & 0x01) == 0 && (r.Protect & 0x100) == 0;
        // The executable's own code and read-only data is never player state. It is a
        // large slice of the address space and costs the same to walk as anything else.
        bool skip = !readable
          || (regionMode == "nost" && r.Type == MEM_IMAGE)
          || (regionMode == "image" && r.Type != MEM_IMAGE);
        if (skip) { RegionsSkipped++; continue; }
        {
          long pos = 0;
          int carry = 0;
          while (pos < size && found.Count < stopAfter && watch.Elapsed.TotalSeconds < maxSeconds) {
            int want = (int)Math.Min((long)CHUNK, size - pos);
            IntPtr got;
            if (!ReadProcessMemory(h, (IntPtr)(start + pos - carry), buf, (IntPtr)(want + carry), out got)) break;
            int have = (int)got.ToInt64();
            if (have <= 0) break;
            if (have > want + carry) have = want + carry;
            BytesRead += have; RegionsRead++;

            for (int i = 0; i + 8 < have; i++) {
              if (Lower(buf[i]) != (byte)'m' || Lower(buf[i + 1]) != (byte)'r') continue;
              int end = TrailerEnd(buf, have, i);
              if (end < 0) continue;
              int searchFrom = Math.Max(0, i - MAX_STRING);
              int nul = -1;
              for (int k = i - 1; k >= searchFrom; k--) if (buf[k] == 0) { nul = k; break; }
              int wStart = nul >= 0 ? nul + 1 : Math.Max(0, i - 700);
              int wEnd = Math.Min(have, end);
              if (CountStats(buf, wStart, wEnd) < 2 && !HasMultiplier(buf, wStart, wEnd)) continue;
              if (!AllStatsSigned(buf, wStart, wEnd)) {
                AmbiguousSkipped++;
                // Kept for diagnosis only, never parsed. Needed to tell a rivens only
                // lossy copy, which would be a genuinely missing riven, apart from a
                // duplicate of one already accepted.
                if (refused.Count < 200) {
                  string rb = Trim(buf, wStart, wEnd);
                  if (rb.Length >= 16) refused.Add(new Found { Address = (start + pos - carry + wStart).ToString("X"), Text = rb });
                }
                continue;
              }
              string block = Trim(buf, wStart, wEnd);
              if (block.Length < 16) continue;
              // The block has to open with a weapon name. Some riven records are split
              // across two strings, leaving a fragment that is stats only: "+103%
              // Multishot / -63.2% Critical Damage MR 13 Rifle" with no name anywhere in
              // the window. Those cannot be matched to a weapon, so they are not rivens
              // as far as anything downstream is concerned, and letting them through
              // inflates the count with fragments.
              if (!StartsWithName(block)) { NamelessSkipped++; continue; }
              if (!seen.Add(Normalise(block))) continue;
              found.Add(new Found {
                Address = (start + pos - carry + wStart).ToString("X"),
                Text = block
              });
            }

            carry = Math.Min(MAX_STRING, have);
            Buffer.BlockCopy(buf, have - carry, buf, 0, carry);
            pos += want;
          }
        }
      }
    } finally { CloseHandle(h); }
    return found;
  }
}
'@

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) {
  # Written to the file as well as stdout. The app reads the file, and a failure it
  # cannot classify is a failure it cannot explain to the player.
  $err = [pscustomobject]@{ error = "$ProcessName is not running" } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Out, $err, [System.Text.UTF8Encoding]::new($false))
  Write-Output $err
  exit 1
}

$preferred = @()
if ($Cache -and -not $RebuildCache -and (Test-Path -LiteralPath $Cache)) {
  try {
    $cached = Get-Content -LiteralPath $Cache -Raw | ConvertFrom-Json
    if ($cached) { $preferred = @($cached | ForEach-Object { [long]$_ }) }
  } catch {
    # A cache written by an older build is newline separated rather than JSON. Read that
    # too rather than discarding a perfectly good list of regions.
    try {
      $lines = @(Get-Content -LiteralPath $Cache | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      $parsed = @();
      foreach ($l in $lines) { $v = 0L; if ([long]::TryParse($l, [ref]$v)) { $parsed += $v } }
      if ($parsed.Count) { $preferred = $parsed }
    } catch { $preferred = @() }
    if (-not $preferred.Count) { $preferred = @() }
  }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$found = [RivenScan]::Run($proc.Id, $StopAfter, $MaxSeconds, $Regions, $preferred)
$sw.Stop()

# Remember the regions the hits came from, so the next scan can start there. Only kept
# when the result looks complete: a scan that timed out or found almost nothing would
# otherwise record a region that happens not to hold the rest, and every later scan
# would trust that thin answer.
$cacheWritten = $false
if ($Cache) {
  $hits = New-Object 'System.Collections.Generic.HashSet[long]'
  foreach ($f in $found) {
    $rs = [RivenScan]::RegionStartFor([Convert]::ToInt64($f.Address, 16))
    if ($rs -ge 0) { $null = $hits.Add($rs) }
  }
  if ($found.Count -ge 20 -and $hits.Count -gt 0) {
    try {
      # A real JSON array. Newline separated bare numbers look like they would parse
      # but do not, ConvertFrom-Json throws, and the cache silently never engages.
      [System.IO.File]::WriteAllText(
        $Cache,
        (ConvertTo-Json -InputObject @($hits) -Compress),
        [System.Text.UTF8Encoding]::new($false))
      $cacheWritten = $true
    } catch { }
  }
}

$json = [pscustomobject]@{
  pid = $proc.Id
  scannedMs = [int]$sw.Elapsed.TotalMilliseconds
  mbPerSec = [math]::Round(([RivenScan]::BytesRead / 1MB) / [math]::Max(0.001, $sw.Elapsed.TotalSeconds), 1)
  bytesRead = [RivenScan]::BytesRead
  regionsSkipped = [RivenScan]::RegionsSkipped
  ambiguousSkipped = [RivenScan]::AmbiguousSkipped
  namelessSkipped = [RivenScan]::NamelessSkipped
  cachedRegionsUsed = [RivenScan]::CachedRegionsUsed
  cacheWritten = $cacheWritten
  timedOut = ($found.Count -ge $StopAfter)
  count = $found.Count
  rivens = @($found | ForEach-Object { [pscustomobject]@{ address = $_.Address; text = $_.Text } })
  refused = @([RivenScan]::Refused | ForEach-Object { [pscustomobject]@{ address = $_.Address; text = $_.Text } })
} | ConvertTo-Json -Depth 5

[System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false))
if (-not $Quiet) {
  Write-Output ("found " + $found.Count + " riven(s) in " + [int]$sw.Elapsed.TotalMilliseconds + "ms")
  Write-Output ("  read " + [math]::Round([RivenScan]::BytesRead / 1MB, 0) + " MB at " +
    [math]::Round(([RivenScan]::BytesRead / 1MB) / [math]::Max(0.001, $sw.Elapsed.TotalSeconds), 1) + " MB/s")
  if ([RivenScan]::CachedRegionsUsed -gt 0) { Write-Output ("  started from " + [RivenScan]::CachedRegionsUsed + " remembered region(s)") }
  else { Write-Output ("  full walk (no region cache yet)") }
  Write-Output ("  skipped " + [RivenScan]::RegionsSkipped + " regions")
  if ([RivenScan]::AmbiguousSkipped -gt 0) {
    Write-Output ("  refused " + [RivenScan]::AmbiguousSkipped + " block(s) with an unsigned stat; those copies drop the minus sign and would misgrade")
  }
  if ($cacheWritten) { Write-Output ("  cached the regions that held them, next scan starts there") }
  foreach ($r in $found) { Write-Output ("  --- " + $r.Address); Write-Output ("    " + ($r.Text -replace "`n", " | ")) }
}
