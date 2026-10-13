Monitor and control your Hoymiles HiOne home battery from Homey Pro - locally over Modbus via the DTS stick, with the S-Miles Cloud as fallback, and a day-ahead price plan that tells your Flows when to buy, hold and sell.

FEATURES
- Local first: live values and most settings go straight to the DTS stick on your network (Modbus TCP, port 502). The app finds the stick by itself, also after its address changes. Older sticks with the native Hoymiles protocol (port 10081) work too.
- Keeps working without internet: everything local carries on during an outage, and the prices for today and tomorrow are stored.
- Home battery in Homey Energy, with charged and discharged energy
- Monitoring: state of charge, battery power, current and voltage, grid power, house load, smart port power, daily/monthly/yearly/lifetime energy, cell spread and highest cell temperature
- Control: battery mode, reserve SOC per mode, a charge ceiling for all modes, and power limits for Force Charge and Force Discharge
- One-step Flow cards: start charging to a level, start selling down to a level, stop back to Self-Consumption, hold the battery at its current charge
- Day-ahead price plan (Netherlands, per quarter hour): buy, sell and peak conditions that move with the day's spread, a charge target based on what the expensive hours will need, and a price chart in the app settings
- Works next to other batteries (e.g. Sessy): report what the other battery does, and the HiOne won't feed it while it charges
- Cloud-only device for a second installation whose stick is not on your network
- Diagnostics in the app settings: the source of every value, a register scan and cell data per battery module

PRICES
Prices come from Frank Energie's public API - no account or key needed, and usable with any Dutch supplier: the market price is the same for everyone. When Frank cannot be reached, dynamisch-tarief.nl stands in automatically. Check the price plan settings of the device (battery wear, efficiency, margin, capacity) before letting Flows trade with your battery.

REQUIREMENTS
- Homey Pro with firmware 12.4.5 or newer
- A Hoymiles HiOne system: a HiOne-(8-20)T-G3 hybrid inverter with its DTS-WL-G3 data transfer stick and one or more HiOne-8B-G3 battery modules. A Backup Box is optional.
- An S-Miles Cloud account, needed to switch battery modes
- The DTS stick on the same network as Homey for local control

ADDING A DEVICE
Tip: sign in once under Apps > Hoymiles HiOne > Configure. Adding a device then logs in by itself.

1. Go to Devices, tap + and search for "Hoymiles HiOne"
2. Select HiOne Station and choose how to connect:
   - Local + Cloud (recommended): local first, the cloud for what the stick cannot do
   - Local (LAN): no account; live values and local settings, no mode switching
   - Cloud only: for an installation whose stick is not on your network
3. Select your station

Tip: give the stick a fixed address in your router (DHCP reservation).

GOOD TO KNOW
- Switching the battery mode always goes through the S-Miles Cloud; the stick has no register for it.
- Settings are stored in the inverter's memory, which wears with every write. The app skips writes that change nothing, but avoid Flows that change settings back and forth every minute.
- Tested on a HiOne-16T-G3 with 4x 8B-G3 battery modules and a DTS-WL-G3 stick. Other HiOne models should work but have not been tested.

DISCLAIMER
This is an unofficial, community-developed integration, not affiliated with or endorsed by Hoymiles Power Electronics Inc. It uses the S-Miles Cloud API and local communication with the DTS stick, neither of which is publicly documented; Hoymiles may change these at any time. Use at your own risk.
