<table>
  <tr>
    <td width="96" valign="top">
      <img src="assets/icon.png" alt="Warframe Companion App Icon" width="82" height="82" />
    </td>
    <td valign="top">
      <h1>Ordis</h1>
      <p>
        A complete free and open source program to track your mastery and see what is tradable or not with many
        feature all in one app.
      </p>
    </td>
  </tr>
</table>

<p>
  <a href="https://github.com/Kawaoii/Ordis">Repository</a> |
  <a href="https://github.com/Kawaoii/Ordis/issues">Report an Issue</a> |
  <a href="#features">Features</a> |
  <a href="#installation">Installation</a> |
  <a href="#build-and-release">Build and Release</a> |
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

> [!IMPORTANT]
> **Ordis is an unofficial fan fork.**
>
> It is based on [Warframe Companion App](https://github.com/Hasan580/Warframe-companion-app)
> by **Hassan F.**, released under an MIT-Style License With Repository Attribution, which
> requires visible attribution to the original project.
>
> All original credit for the base project goes to Hassan F. This fork is maintained
> independently and is **not affiliated with or endorsed by Digital Extremes**.

## Overview

Warframe Companion App is an Electron desktop utility focused on quality-of-life workflows for Warframe players:

- Track mastered and unmastered items by category
- Search and filter large item collections quickly
- View item details, drops, and crafting requirements
- Access Warframe Market and trading tools from one place
- Monitor Prime Resurgence and worldstate information
- Use the MR Calculator and progress stats to plan mastery goals

## Features

- Category-driven item explorer
- Mastery progression ring and completion metrics
- Real-time filters for all, mastered, and unmastered items
- Item detail modal with acquisition and crafting context
- Market view with whisper copy actions
- Prime Resurgence and Worldstate panels
- Native Electron window controls and update checks

## Application Preview

![Warframe Companion App Screenshot](./assets/warframe-companion-app.png)


## Tech Stack

- Electron
- Vanilla JavaScript (CommonJS)
- HTML
- CSS
- electron-builder

## Public APIs Used

This project uses public community and game-related APIs, including:

- [WarframeStat](https://github.com/WFCD)
- [warframe.market](https://warframe.market/api_docs)
- GitHub Releases API for app updates

## Installation

### Prerequisites

- Node.js 18+
- npm 9+

### Local development

```bash
npm install
npm run dev
```

## Build and Release

### Standard Windows build

```bash
npm run build
```

### Other useful commands

```bash
npm run package
```

## Project Structure

```text
assets/                     App icon and static assets
index.html                  Main UI markup
styles.css                  Application styling
renderer.js                 UI logic and data integration
market.js                   Market panel behavior
main.js                     Electron main process
preload.js                  Electron preload bridge
```

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Code of Conduct

Please follow the guidelines in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Disclaimer

Ordis is a community-built, unofficial fan project. It is not affiliated with, sponsored by,
or endorsed by Digital Extremes. Warframe, Ordis, and related names are trademarks of
Digital Extremes Ltd. No affiliation or endorsement is implied.

Data is supplied by community APIs including [WarframeStat](https://github.com/WFCD) and
[warframe.market](https://warframe.market). Use them at your own risk and respect their terms.

## License

This project is a fork of [Warframe Companion App](https://github.com/Hasan580/Warframe-companion-app)
by **Hassan F.**, distributed under an
[MIT-Style License With Repository Attribution](./LICENSE).

That licence permits redistribution and modification, provided visible attribution to the
original repository is given. This fork retains that requirement: the original copyright
notice, licence text, and attribution are preserved in this README, in the in-app Settings
footer, and in the release notes. The upstream `LICENSE` file is left unmodified.
