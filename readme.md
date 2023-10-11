
## Dial2Verify-Twilio V2

A big upgrade from [Dial2Verify-Twilio V1](https://github.com/natsu90/dial2verify-twilio)

### Demo

[https://dial.ss.my](https://dial.ss.my)

1. A session key is assigned when webpage is opened

2. User send a request with the session key as a parameter

3. A twilio number is assigned and return to the user

4. User send a phone call to the phone number within 20 seconds

5. Twilio webhook request is received when the phone call is initiated

6. The phone call is verifid and the webpage is refreshed

### Prerequisites

1. Twilio Account, duh

2. Pre-determined App URL

### Installation

1. `npm install`

2. `cp .env.example .env`

3. Fill up `.env`

4. `npm run start`

### Warning

Phone number can be spoofed so this is not secure to replace a traditional authentication,

unless if your targeted customers are from US then there is spoof proofing mechanism; https://www.twilio.com/docs/voice/trusted-calling-with-shakenstir#incoming-calls

### License

Licensed under the [MIT license](http://opensource.org/licenses/MIT)
