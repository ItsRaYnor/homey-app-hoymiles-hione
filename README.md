# Hoymiles HiOne — Homey App

Monitor and control your **Hoymiles HiOne** home battery from Homey Pro — **locally over Modbus TCP** via the DTS stick, with the S-Miles Cloud as fallback, and a day-ahead **price plan** that tells your Flows when to buy, hold and sell.

[![Homey App](https://img.shields.io/badge/Homey-App%20Store-00A94F?logo=homey)](https://homey.app/a/com.hoymiles.hione)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Disclaimer

> **This is an unofficial, community-developed integration.**
>
> - Not affiliated with, endorsed by, or supported by **Hoymiles Power Electronics Inc.** Please don't contact Hoymiles about it — open an issue here instead.
> - Uses the S-Miles Cloud API (`neapi.hoymiles.com`) and local communication with the DTS stick, neither of which is publicly documented.
> - Hoymiles may change these interfaces at any time without notice — app functionality may break as a result.
> - Your **S-Miles Cloud credentials** are stored in Homey and only sent to the official Hoymiles API.
> - Use at your own risk. The developers accept no liability for data loss, incorrect readings, or unintended battery mode changes.

---

## Features

- **Local first.** Live values and most settings go straight to the DTS stick on your LAN (Modbus TCP, port 502). The app finds the stick by itself and finds it again when its address changes. Older sticks that speak the native Hoymiles protocol (port 10081) are supported too.
- **Keeps working without internet.** Everything local carries on when the internet is down; prices already fetched for today and tomorrow are stored and survive a restart.
- **Home battery in Homey Energy**, with charged and discharged energy.
- **Monitoring:** state of charge, battery power, current and voltage, grid power, house load, smart port power, daily/monthly/yearly/lifetime energy, cell spread and highest cell temperature, and whether data came from the stick or the cloud.
- **Control:** battery mode, reserve SOC per mode, a charge ceiling for all modes, and power limits for Force Charge and Force Discharge.
- **One-step Flow cards** — *Start charging to a level*, *Start selling down to a level*, *Stop, back to Self-Consumption*, *Hold the battery at its current charge* — instead of chains of setting cards with delays.
- **Day-ahead price plan (Netherlands, per quarter hour)** with conditions that move with the day's spread instead of fixed thresholds. See [Price plan](#price-plan).
- **Works next to other batteries** (e.g. Sessy): a Flow reports what the other battery is doing, and the HiOne does not feed it while it charges.
- **Cloud-only device** for a second installation whose stick is not on your network.
- **Diagnostics** in the app settings: the source of every value, a register scan and cell data per battery module.

---

## Requirements

- Homey Pro with firmware **12.4.5 or newer** (needed for the home battery device class)
- A Hoymiles **HiOne** system: a HiOne-(8–20)T-G3 hybrid inverter with its **DTS-WL-G3** data transfer stick and one or more HiOne-8B-G3 battery modules. A Backup Box (e.g. 63T-G3) is optional.
- An **S-Miles Cloud** account (the one you use in the Hoymiles app) — needed to switch battery modes and for the cloud-only values
- The DTS stick on the same network as Homey for local control

> **Tested on** a HiOne-16T-G3 with 4× 8B-G3 battery modules and a DTS-WL-G3 stick. Other HiOne models should work but have not been tested — reports are welcome. Other Hoymiles products (microinverters, HYT series) are not supported.

---

## Installation

### Via Homey App Store
Search for **"Hoymiles HiOne"** in the Homey App Store, or open [the app page](https://homey.app/a/com.hoymiles.hione).

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

**Tip:** sign in once under *Apps → Hoymiles HiOne → Configure → Account*. Adding a device then logs in by itself.

1. In the Homey app go to **Devices**, tap **+** and search for **Hoymiles HiOne**
2. Tap **HiOne Station** and choose how to connect:
   - **Local + Cloud** (recommended) — local first, the cloud for what the stick cannot do
   - **Local (LAN)** — no account; live values and local settings only, no mode switching
   - **Cloud only** — for an installation whose stick is not on your network, such as a second station on the same account
3. Select your station

The connection can be changed later in the device settings (**Connection**: *Local (Modbus) with cloud top-up* or *Cloud only*).

### The stick's address
The app scans your network for the stick. If you want to set it yourself: look in your router for a device named `DTS-...` or `DTUBI-...`, and enter its address under *Configure → Connection* or in the device settings. Giving the stick a fixed address (a DHCP reservation in your router) is still a good idea.

---

## What runs where

| | Local (stick) | Cloud |
|---|:---:|:---:|
| Live values: state of charge, battery, grid, load, smart port | ✓ | fallback |
| Cell data per battery module | ✓ | — |
| Reserve SOC per mode, power limits, charge ceiling | ✓ | active mode only |
| **Switching battery mode** | — | ✓ |
| Energy totals, CO₂, savings (tiles marked ☁) | — | ✓ |
| Peak Shaving, Time of Use, dry contact | — | ✓ |

The stick has no register for the battery mode, so **switching modes always needs the cloud.** Everything else keeps working during an internet outage, in whichever mode the outage finds the battery.

---

## Price plan

The app fetches the day-ahead prices per quarter hour and turns one question — *does a stored kWh earn more than it costs?* — into Flow conditions:

```
discharging pays  when  price now ≥ day low / efficiency + wear + margin
```

The thresholds move with the day: on a day where every quarter is expensive the battery still buys at the bottom, and on a flat day it does nothing. Tomorrow's prices count once they are published (around 13:00).

- **Conditions:** *buy moment*, *discharging pays*, *sell moment*, *today's spread pays*, *still needs charging*, *one of the dearest quarters the battery can still cover*, *a cheaper refill is coming before the dearest moment*
- **Actions:** *start charging to what the dear hours will need* — a charge target calculated from the coming expensive quarters and the house load, instead of a fixed 95 %
- **Price chart** under *Configure → Prices*, for today and tomorrow, with the verdict per quarter

**Prices come from Frank Energie's public API** (no account or key). It works with any Dutch supplier: the market price is the same for everyone, and a different supplier markup shifts every quarter by the same amount, which the decisions hardly notice. When Frank cannot be reached, **[dynamisch-tarief.nl](https://www.dynamisch-tarief.nl)** stands in automatically (same market price); Frank takes over again as soon as it is back.

**Check the settings before letting Flows trade** (device settings → *Price plan*): battery wear, round-trip efficiency, required margin, usable capacity, discharge floor and how much less exporting earns than using the energy yourself. The defaults are tuned to the tested system and a Dutch contract with net metering.

---

## Flow cards

### Triggers
- Battery mode changed

### Conditions
- Battery **is / is not** charging, idle or discharging
- Battery mode **is / is not** …
- Grid **is / is not** importing power
- Connection **is / is not** local
- Price plan: buy moment, discharging pays, sell moment, today's spread pays, still needs charging, dearest quarter, cheaper refill ahead
- Another battery **is / is not** charging or discharging

### Actions
- **Start charging to a level**, **Start charging to what the dear hours will need**, **Start selling down to a level**, **Stop charging or selling, back to Self-Consumption**
- **Hold the battery at its current charge** — writes only when something changed, to spare the inverter's memory; does nothing while Force Charge runs, since that mode charges to its own target
- **Report that another battery is charging / discharging** — call it every minute while that holds; the report expires by itself after 3 minutes
- Set battery mode (Self-Consumption, Economy, Backup, Off-Grid, Force Charge, Force Discharge, Peak Shaving, Time of Use, AI Mode)
- Set reserve SOC, or the reserve SOC of a specific mode
- Set the local charge ceiling; limit charge or discharge power locally (keeps the mode)
- Set max power, max charge power, max discharge power, max SOC, grid power limit
- Set Peak Shaving parameters, Time of Use period, switch the dry contact
- Set power limit and turn the inverter on/off (local) — for sticks that support it; the DTS-WL-G3 does not

> **Inverter memory:** settings are stored in the inverter's EEPROM, which wears with every write. The app skips writes that would not change anything, but avoid Flows that change a setting every minute back and forth.

---

## Known limitations

| Limitation | Detail |
|---|---|
| Unofficial interfaces | May break if Hoymiles changes its cloud or the stick firmware |
| Mode switching | Needs the S-Miles Cloud; not possible during an internet outage |
| Price plan | Dutch day-ahead prices only |
| Tested hardware | One HiOne-16T-G3 system; other HiOne models untested |
| Polling | Intervals below 30 seconds can disrupt the cloud and the Hoymiles app |

---

## Related projects & sources

- **[homeassistant-hoymiles-cloud](https://github.com/Philra94/homeassistant-hoymiles-cloud)** — Home Assistant integration for the S-Miles Cloud API
- **[hoymiles-wifi](https://github.com/suaveolent/hoymiles-wifi)** — Python library for the native local protocol of Hoymiles DTUs
- **[hoymiles-web-api](https://github.com/hosssa/hoymiles-web-api)** — Web API wrapper for Hoymiles cloud communication
- **[Frank Energie](https://www.frankenergie.nl)** and **[dynamisch-tarief.nl](https://www.dynamisch-tarief.nl)** — day-ahead prices

---

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/ItsRaYnor/homey-app-hoymiles-hione/issues). For questions, the Homey Community topic is the place.

---

## License

MIT — see [LICENSE](LICENSE)
