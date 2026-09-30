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

  public static int BytesRead = 0;
  public static int RegionsRead = 0;
  public static long RegionsSkipped = 0;

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

  public static List<Found> Run(int pid, int stopAfter, int maxSeconds, string regionMode) {
    var found = new List<Found>();
    var seen = new HashSet<string>();
    var watch = Stopwatch.StartNew();
    IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
    if (h == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try {
      int mbiSize = Marshal.SizeOf(typeof(MBI));
      byte[] buf = new byte[CHUNK + MAX_STRING + TOOLS];
      long max = 0x00007FFFFFFFFFFF, addr = 0;
      while (addr < max && found.Count < stopAfter && watch.Elapsed.TotalSeconds < maxSeconds) {
        MBI m;
        if (VirtualQueryEx(h, (IntPtr)addr, out m, (IntPtr)mbiSize) == IntPtr.Zero) break;
        long start = m.BaseAddress.ToInt64();
        long size = (long)m.RegionSize.ToUInt64();
        if (size <= 0) break;

        bool readable = m.State == MEM_COMMIT && (m.Protect & 0x01) == 0 && (m.Protect & 0x100) == 0;
        // The executable's own code and read-only data is never player state. It is a
        // large slice of the address space and costs the same to walk as anything else.
        bool skip = !readable
          || (regionMode == "nost" && m.Type == MEM_IMAGE)
          || (regionMode == "image" && m.Type != MEM_IMAGE);
        if (skip) { RegionsSkipped++; }
        else {
          long pos = start;
          int carry = 0;
          while (pos < size && found.Count < stopAfter && watch.Elapsed.TotalSeconds < maxSeconds) {
            int want = (int)Math.Min((long)CHUNK, size - pos);
            IntPtr at = (IntPtr)(pos - carry);
            IntPtr got;
            if (!ReadProcessMemory(h, (IntPtr)(start + at.ToInt64()), buf, (IntPtr)(want + carry), out got)) break;
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
              string block = Trim(buf, wStart, wEnd);
              if (block.Length < 16) continue;
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
        addr = start + size;
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

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$found = [RivenScan]::Run($proc.Id, $StopAfter, $MaxSeconds, $Regions)
$sw.Stop()

$json = [pscustomobject]@{
  pid = $proc.Id
  scannedMs = [int]$sw.Elapsed.TotalMilliseconds
  mbPerSec = [math]::Round(([RivenScan]::BytesRead / 1MB) / [math]::Max(0.001, $sw.Elapsed.TotalSeconds), 1)
  bytesRead = [RivenScan]::BytesRead
  regionsSkipped = [RivenScan]::RegionsSkipped
  timedOut = ($found.Count -ge $StopAfter)
  count = $found.Count
  rivens = @($found | ForEach-Object { [pscustomobject]@{ address = $_.Address; text = $_.Text } })
} | ConvertTo-Json -Depth 5

[System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false))
if (-not $Quiet) {
  Write-Output ("found " + $found.Count + " riven(s) in " + [int]$sw.Elapsed.TotalMilliseconds + "ms")
  Write-Output ("  read " + [math]::Round([RivenScan]::BytesRead / 1MB, 0) + " MB at " +
    [math]::Round(([RivenScan]::BytesRead / 1MB) / [math]::Max(0.001, $sw.Elapsed.TotalSeconds), 1) + " MB/s")
  Write-Output ("  skipped " + [RivenScan]::RegionsSkipped + " regions")
  foreach ($r in $found) { Write-Output ("  --- " + $r.Address); Write-Output ("    " + ($r.Text -replace "`n", " | ")) }
}
