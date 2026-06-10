Monitor and control your Hoymiles HiOne all-in-one battery storage system from Homey.

FEATURES
- Real-time monitoring: PV power, battery state-of-charge, battery charge/discharge power, grid import/export and home load
- Energy totals: daily, monthly, yearly and lifetime yield, battery charged/discharged totals and CO2 reduction
- Battery mode control via Flows: Self-Consumption, Economy, Backup, Off-Grid, Self-Consumption + Max Power, Backup + Max Power, Peak Shaving, Time of Use
- Reserve SOC control: read and set the minimum battery state-of-charge (slider + Flow action)
- Peak Shaving configuration via Flow: reserve SOC, max SOC and grid power limit
- EPS savings: today's and total savings as sensors
- Dry contact (relay) control via Flow (hardware dependent)
- Flow conditions: battery is/is not charging, grid is/is not importing, battery mode is/is not, connection is/is not local
- Three connection modes: Local (LAN), Local + Cloud (recommended), or Cloud only

REQUIREMENTS
- Homey Pro (2019 or 2023) with firmware >= 5.0.0
- Hoymiles HiOne system: HiOne-(8-20)T-G3 hybrid inverter with the included
  DTS-WL-G3 data transfer stick (WiFi or LAN mode) and one or more
  HiOne-8B-G3 battery modules. The Backup Box (e.g. 63T-G3) is optional
  and provides EPS/backup power switching.
- For cloud/hybrid mode: an active S-Miles Cloud account
- For local mode: the IP address of the DTS-WL-G3 stick on your LAN

ADDING A DEVICE
Tip: log in once via the app settings (Apps > Hoymiles HiOne > Configure).
Adding a device via Cloud then logs in automatically.

1. Open the Homey app and go to Devices
2. Tap + and search for "Hoymiles HiOne"
3. Select HiOne Station
4. Choose your connection mode:
   - Local (LAN): enter the IP address of your HiBox gateway
   - Local + Cloud: enter the gateway IP, then log in with your S-Miles Cloud credentials
   - Cloud only: log in with your S-Miles Cloud email and password (skipped when an account is saved)
5. Select your station from the list
6. Data refreshes every 60 seconds

FINDING YOUR GATEWAY/DTS IP ADDRESS
Check your router's admin page under connected devices. Look for a device named DTS-..., DTUBI-... or HiBox.
Tip: use Local + Cloud for the most reliable experience.
Tip: give the gateway a fixed IP address (DHCP reservation in your router), so the local connection keeps working after a router restart.

LOCAL CONTROL (POWER LIMIT & INVERTER ON/OFF)
The local connection talks directly to the gateway on your LAN (TCP port 10081), using the same protocol as the hoymiles-wifi project. Two Flow actions use this:

- "Set power limit (local)": limits the inverter output to a percentage (2-100%).
  WARNING: every change is written to the inverter's EEPROM memory. Frequent automated
  changes (e.g. every few minutes) wear out this chip. Limit changes to a few per day.
- "Turn inverter on/off (local)": switches an inverter on or off by its serial number
  (found on the type plate or in the S-Miles app). A typical use case is turning the
  inverter off during negative energy prices and back on afterwards.

These actions require the gateway/DTS IP to be configured (Local or Local + Cloud mode).
Note: this protocol is reverse-engineered from the hoymiles-wifi project (verified on
DTU/HMS-W and HYS/HYT hybrid hardware); behaviour on the HiOne DTS-WL-G3 has not
been hardware-verified yet.

FLOW CARDS
Actions:
- Set battery mode (Self-Consumption, Economy, Backup, Off-Grid, Self-Consumption + Max Power, Backup + Max Power, Peak Shaving, Time of Use)
- Set reserve SOC (minimum battery state-of-charge, cloud connection required)
- Set Peak Shaving parameters (reserve SOC, max SOC, grid power limit)
- Switch dry contact on/off (relay output, hardware dependent)

Conditions:
- Battery is/is not charging
- Grid is/is not importing power
- Battery mode is/is not a specific mode
- Connection is/is not local (LAN)

DISCLAIMER
This is an unofficial, community-developed integration. Not affiliated with or endorsed by Hoymiles Power Electronics Inc. Uses the reverse-engineered S-Miles Cloud API and/or local DTU communication. Hoymiles may change these interfaces at any time. Use at your own risk.
