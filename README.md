# Hoymiles HiOne — Homey App

Monitor and control your **Hoymiles HiOne** all-in-one battery energy storage system (BESS) from Homey.

[![Homey App](https://img.shields.io/badge/Homey-App%20Store-00A94F?logo=homey)](https://homey.app/a/com.hoymiles.hione)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Disclaimer

> **This is an unofficial, community-developed integration.**
>
> - Not affiliated with, endorsed by, or supported by **Hoymiles Power Electronics Inc.**
> - Uses the reverse-engineered S-Miles Cloud API (`neapi.hoymiles.com`) and/or local DTU communication, neither of which are publicly documented.
> - Hoymiles may change or discontinue these interfaces at any time without notice — app functionality may break as a result.
> - Your **S-Miles Cloud credentials** are stored securely in Homey's encrypted device store. They are only sent to the official Hoymiles API and never to any third party.
> - Use at your own risk. The developers accept no liability for data loss, incorrect readings, or unintended battery mode changes.

---

## Features

- **Real-time monitoring**: PV power, battery state-of-charge, battery charge/discharge power, grid import/export, home load
- **Energy totals**: daily yield and lifetime total
- **Battery mode control** via Flows:
  - Self-Consumption, Economy, Backup, Off-Grid, Peak Shaving, Time of Use
- **Flow conditions**: battery is/is not charging, grid is/is not importing, battery mode is/is not, connection is/is not local
- **Three connection modes**:
  - **Local (LAN)** — direct connection to the HiBox gateway via IP (port 10081, protobuf). No cloud account needed. Works offline.
  - **Local + Cloud** — local as primary, S-Miles Cloud as fallback. Best reliability.
  - **Cloud only** — via S-Miles Cloud API. Requires a hoymiles.com account.
- **Connection source indicator**: see whether data comes from local or cloud

---

## Requirements

- Homey Pro (2019 or 2023) with firmware >= 5.0.0
- Hoymiles **HiOne** all-in-one BESS (tested: 3-phase models with HiBox-63T-G3 gateway)
- For cloud/hybrid mode: an active **S-Miles Cloud** account (the same credentials used in the Hoymiles app)
- For local mode: the IP address of the HiBox gateway on your LAN

> **Compatibility note**: This app was designed for the HiOne (HiBox-63T-G3 gateway). Other Hoymiles products (DTU, microinverters, HYT series) are *not* supported.

---

## Installation

### Via Homey App Store
Search for **"Hoymiles HiOne"** in the Homey App Store.

### Via CLI (sideloading / development)
```bash
npm install -g homey
git clone https://github.com/ItsRaYnor/homey-app-hoymiles-hione
cd homey-app-hoymiles-hione
homey login
homey app install
```

---

## Adding a device

After installing the app, you need to add a device to start monitoring your HiOne:

1. Open the Homey app on your phone
2. Go to **Devices** (bottom bar)
3. Tap the **+** button (top right) to add a new device
4. Search for **"Hoymiles HiOne"** or find it under the **Energy** category
5. Tap **HiOne Station**
6. Choose your connection mode:
   - **Local (LAN)** — enter the IP address of your HiBox gateway (find it in your router under connected devices, look for `DTUBI-...` or `HiBox`)
   - **Local + Cloud** — enter the gateway IP first, then log in with your S-Miles Cloud credentials
   - **Cloud only** — log in with your S-Miles Cloud email and password
7. Select your station from the list
8. Done — data refreshes every 60 seconds

### Finding your HiBox IP address

The HiBox-63T-G3 gateway connects to your local network via Ethernet. To find its IP:

- Check your router's admin page under connected/DHCP devices
- Look for a device named `DTUBI-...` or `HiBox`
- The local connection uses port **10081** (configured automatically)

> **Tip**: For the most reliable experience, choose **Local + Cloud**. The app will use your local network for fast data retrieval, and fall back to the cloud if the gateway is temporarily unreachable.

---

## Data & capabilities

| Capability | Description | Unit |
|---|---|---|
| PV Power | Current solar panel output | W |
| Battery Power | Battery charge (+) / discharge (-) power | W |
| Grid Power | Grid import (+) / export (-) power | W |
| Load Power | Current home consumption | W |
| Battery SoC | Battery state of charge | % |
| Daily Energy | Energy produced today | kWh |
| Total Energy | Lifetime energy produced | kWh |
| Battery Mode | Current operating mode | — |
| Connection Source | Local (LAN) or Cloud | — |

---

## Flow cards

### Actions
- **Set battery mode** — change the battery operating mode (Self-Consumption, Economy, Backup, Off-Grid, Peak Shaving, Time of Use)

### Conditions
- Battery **is/is not** charging
- Grid **is/is not** importing power
- Battery mode **is/is not** a specific mode
- Connection **is/is not** local (LAN)

---

## How it works

### S-Miles Cloud API

The app communicates with the Hoymiles cloud via the REST API at `neapi.hoymiles.com`. Authentication uses your S-Miles Cloud email and an MD5-hashed password. The token is valid for 2 hours and refreshes automatically.

Key endpoints:
- Login and authentication
- Station listing and real-time data (power flows, SoC, energy totals)
- Battery mode read/write (action code 1013)

### Local API (HiBox gateway)

For local communication, the app connects to the HiBox-63T-G3 gateway over TCP port 10081 using protobuf-encoded messages. This is the same protocol used by the Hoymiles mobile app on your local network.

- No authentication required on the local network
- Messages use a binary frame with `HM` header, command ID, sequence number, and CRC16
- Real-time data, energy storage data, and battery mode control are all available locally
- Polling interval: 60 seconds (aggressive polling below 30s can disrupt cloud connectivity)

---

## Known limitations

| Limitation | Detail |
|---|---|
| Unofficial API | May break if Hoymiles updates their backend or local protocol |
| Write operations | Only battery mode can be changed; charge limits and schedules are not yet supported |
| HiOne only | Not tested with DTU, micro-inverters, or HYT series |
| Local polling | Intervals below 30 seconds can disrupt cloud and mobile app connectivity |

---

## Related projects & sources

This app was built with insights from several community projects and resources:

- **[homeassistant-hoymiles-cloud](https://github.com/Philra94/homeassistant-hoymiles-cloud)** — Home Assistant integration for the S-Miles Cloud API
- **[hoymiles-wifi](https://github.com/suaveolent/hoymiles-wifi)** — Python library for local communication with Hoymiles DTUs via protobuf over TCP
- **[hoymiles-web-api](https://github.com/hosssa/hoymiles-web-api)** — Web API wrapper for Hoymiles cloud communication
- **[AhoyDTU](https://ahoydtu.de)** — Open-source DTU replacement for Hoymiles microinverters
- **[OpenDTU](https://openelab.io)** — Local solar monitoring for Hoymiles inverters

---

## Contributing

Pull requests and issue reports are welcome on [GitHub](https://github.com/ItsRaYnor/homey-app-hoymiles-hione/issues).

If the API stops working, the most likely fix is updating field names in `lib/HoymilesApi.js` or protobuf definitions in `lib/HoymilesLocal.js`.

---

## License

MIT — see [LICENSE](LICENSE)
