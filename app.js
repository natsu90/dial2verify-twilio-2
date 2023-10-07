
import * as dotenv from 'dotenv';
import twilio from 'twilio';
import moment from 'moment';
import express from 'express';
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import cron from 'node-cron'
import cookieParser from 'cookie-parser'
import sessions from 'express-session'
import useragent from 'express-useragent'
import QRCode from 'easyqrcodejs-nodejs'
import ejs from 'ejs';
import cors from 'cors'
import { URL } from 'url';
import sqliteStoreFactory from 'express-session-sqlite'

dotenv.config({ path: '.env' });

const __dirname = new URL('.', import.meta.url).pathname;
const appUrl = process.env.APP_URL;
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const subAccountName = 'dial2verify';
const verificationValidity = 15; // in seconds
const db = await open({
    filename: './sqlite.db',
    driver: sqlite3.Database
})
const SqliteStore = sqliteStoreFactory.default(sessions)

// db.on('trace', (data) => {
//     console.log(data)
// })

// create verifications table
const createVerificationTable = async() => {
    await db.exec(`drop table if exists verifications`)
    await db.exec(`create table verifications (
        id integer primary key autoincrement,
        session_id varchar(50) not null,
        dial_phone_number varchar(20) not null,
        expired_at datetime not null,
        caller_phone_number varchar(50) null
    )`)
}
await createVerificationTable()

// create twilio_numbers table
await db.exec(`drop table if exists twilio_numbers`)
await db.exec(`create table twilio_numbers (
        id integer primary key autoincrement,
        sid varchar(50) not null,
        phone_number varchar(20) not null,
        expired_at datetime not null
    )`)

let client = twilio(accountSid, authToken);

const getSubAccounts = async() => {
    return await client.api.v2010.accounts
        .list({
            friendlyName: subAccountName, 
            status: 'active', 
            limit: 1
        });
};

const createSubAccount = async() => {
    return await client.api.v2010.accounts
        .create({friendlyName: subAccountName});
};

const getSubAccount = async() => {

    let subAccount;
    const subAccounts = await getSubAccounts();
    
    if (subAccounts.length > 0) {
        subAccount = subAccounts[0];
    } else {
        subAccount = await createSubAccount();
    }

    return subAccount;
}

const closeSubAccount = async(id) => {
    return await client.api.v2010.accounts(id)
        .update({status: 'close'})
}

const subAccount = await getSubAccount()
const subAccountSid = subAccount.sid
const subAccountAuthToken = subAccount.authToken

client = twilio(accountSid, authToken, {accountSid: subAccountSid})

const getNumbers = async() => {
    return await client.incomingPhoneNumbers.list()
}

const deleteNumber = async(sid) => {
    return await client.incomingPhoneNumbers(sid).remove()
}

const deleteExpiredNumbers = async() => {

    const currentTime = moment().format('YYYY-MM-DD HH:mm:ss')
    db.each('select * from twilio_numbers where expired_at <= "'+ currentTime +'"', async(err, row) => {
        await deleteNumber(row.sid)
        await db.exec(`delete from twilio_numbers where id = ?`, [row.id])
    })
}

const importTwilioNumber = async(number) => {

    return await db.run(`insert into twilio_numbers (sid, phone_number, expired_at) values (?, ?, ?)`, 
        [
            number.sid,
            number.phoneNumber,
            moment(number.dateCreated).add(1, 'M').startOf('day').format('YYYY-MM-DD HH:mm:ss')
        ])
}

const buyNumber = async() => {

    const availableNumber = (await client.availablePhoneNumbers('US')
        .local.list({limit: 1}))[0]

    const newNumber = await client.incomingPhoneNumbers
        .create({
            phoneNumber: availableNumber.phoneNumber,
            voiceUrl: appUrl + '/twilio'
        })

    await importTwilioNumber(newNumber)

    return newNumber.phoneNumber
}

const deleteCallLog = (callSid) => {
    client.calls(callSid).remove()
}

const getVerificationBySessionId = async(sessionId) => {
    return (await db.get(`select * from verifications where session_id = ?`, [sessionId]))
}

const requestNumber = async(sessionId) => {

    console.log('requesting number')

    let phoneNumber;
    const validationTime = moment().add(verificationValidity, 'seconds').format('YYYY-MM-DD HH:mm:ss')
    const currentTime = moment().format('YYYY-MM-DD HH:mm:ss')
    const verification = await getVerificationBySessionId(sessionId)

    if (verification) {
        // already verified
        if (verification.caller_phone_number !== null) {
            return null
        // extend expired_at if not expired
        } else if (verification.expired_at >= moment().format('YYYY-MM-DD HH:mm:ss')) {
            await db.run(`update verifications set expired_at = ? where session_id = ?`, [validationTime, sessionId])
            return verification.caller_phone_number
        }
    }

    // get oldest twilio number
    let twilioNumber = await db.get(`select phone_number from twilio_numbers
        where phone_number not in (select dial_phone_number from verifications where expired_at >= ?)
        order by expired_at asc limit 1`, [currentTime])

    // buy a number if no available number
    if (twilioNumber) {
        phoneNumber = twilioNumber.phone_number
    } else {
        phoneNumber = await buyNumber()
    }

    if (verification) {
        // update verification
        await db.run(`update verifications set dial_phone_number = ?, expired_at = ? where session_id = ?`, 
            [phoneNumber, validationTime, sessionId])
    } else {
        // add verifications record
        await db.run(`insert into verifications (dial_phone_number, expired_at, session_id) values (?, ?, ?)`,
            [phoneNumber, validationTime, sessionId])
    }

    return phoneNumber
}

const validateSessionId = async(sessionId) => {
    return (await db.get(`select count(sid) as count from sessions where sid = ?`, [sessionId])).count > 0
}

const getVerificationByDialNumber = async(dialNumber) => {
    const currentTime = moment().format('YYYY-MM-DD HH:mm:ss')
    return (await db.get(`select * from verifications where dial_phone_number = ? 
        and expired_at >= ?`, [dialNumber, currentTime]))
}

const updateVerification = async(id, callerNumber) => {
    const currentTime = moment().format('YYYY-MM-DD HH:mm:ss')
    return (await db.run(`update verifications set caller_phone_number = ?, expired_at = ? where id = ?`, [callerNumber, currentTime, id]))
}

const importTwilioNumbers = async() => {

    const numbers = await getNumbers()

    numbers.forEach((number) => importTwilioNumber(number))
}

await importTwilioNumbers()

// run at 00:01AM
cron.schedule('1 0 * * *', async() => {
    await deleteExpiredNumbers()
    await createVerificationTable()
});

const twiml = new twilio.twiml.VoiceResponse();
const app = express()
const port = 3003
// creating 24 hours from milliseconds
const oneDay = 1000 * 60 * 60 * 24;

// express middlewares
app.enable('trust proxy');
app.use(sessions({
    secret: process.env.SESSION_SECRET_KEY,
    saveUninitialized:true,
    cookie: { maxAge: oneDay },
    resave: false,
    store: new SqliteStore({
        driver: sqlite3.Database,
        path: './sqlite.db',
        ttl: oneDay,
        cleanupInterval: 300000
    }),
}));
app.use(cors())
app.use(useragent.express());
app.use(cookieParser());
app.use(express.json())
app.use(express.urlencoded({extended: true}));
app.engine('html', ejs.renderFile)

// main page
app.get('/', async(req, res) => {

    const sessionId = req.sessionID
    const verification = await getVerificationBySessionId(sessionId)
    let isVerified = false
    let callerNumber = null

    if (verification) {
        isVerified = verification.caller_phone_number !== null
        callerNumber = verification.caller_phone_number
    }

    res.render(__dirname + '/index.html', {
        sessionId: sessionId, 
        isMobile: req.useragent.isMobile, 
        isVerified: isVerified,
        callerNumber: callerNumber
    })
})

// requesting phone number link
app.get('/ses/:sessionId', async(req, res) => {

    const sessionId = req.params.sessionId
    const isValid = await validateSessionId(sessionId)

    if (!isValid) {
        return res.status(400).send('bad_request')
    }

    if (!req.useragent.isMobile)
        return res.redirect('/qr/'+ sessionId)

    // get phoneNumber
    const phoneNumber = await requestNumber(sessionId)

    console.log('getting phoneNumber', phoneNumber)

    if (phoneNumber) {
        res.redirect(301, 'tel:'+ phoneNumber)
    } else {
        res.redirect('/verified')
    }
})

// requesting phone number ajax
app.post('/call', async(req, res) => {

    const sessionId = req.body.sessionId
    const isValid = await validateSessionId(sessionId)

    if (!isValid) {
        return res.status(400).send('bad_request')
    }

    // get phoneNumber
    const phoneNumber = await requestNumber(sessionId)

    if (phoneNumber)
        res.send(phoneNumber)
    else
        res.status(400).send('verified')
})

app.get('/verified', (req, res) => {

    res.send(`Session is verified. You can close this window.`)
})

// qr code image of temporary main page
app.get('/qr/:sessionId', async(req, res) => {

    const sessionId = req.params.sessionId
    const isValid = await validateSessionId(sessionId)

    if (!isValid) {
        return res.status(400).send('bad_request')
    }
    
    const qrCode = new QRCode({
        title: 'Open from phone browser',
        titleHeight: 70,
        titleTop: 25,
        titleFont: "normal normal bold 24px Arial",
        text: appUrl + '/ses/' + sessionId,
        width: 512,
        height: 512,
        colorDark : '#000000',
        colorLight : '#FFFFFF',
        correctLevel : QRCode.CorrectLevel.H,
        quietZone: 12,
        quietZoneColor: '#FFFFFF'
    })

    qrCode.toDataURL().then((base64data) => {
        base64data = base64data.replace(/^data:image\/png;base64,/, '')
        const img = Buffer.from(base64data, 'base64')
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': img.length
        });
        res.end(img)
    })
})

// short polling to update main page
app.get('/poll/:sessionId', async(req, res) => {

    const sessionId = req.params.sessionId
    const isValid = await validateSessionId(sessionId)

    if (!isValid) {
        return res.status(400).send('bad_request')
    }

    let isVerified = false
    const verification = await getVerificationBySessionId(sessionId)
    if (verification && verification.caller_phone_number !== null) {
        isVerified = true
    }

    res.send(isVerified ? 'verified' : '').end()
})

// twilio voice webhook
const xmlString = twiml.reject().toString()
app.post('/twilio', twilio.webhook(subAccountAuthToken), async(req, res) => {

    const dialNumber = req.body.Called
    const callerNumber = req.body.Caller
    const callSid = req.body.CallSid
    const verification = await getVerificationByDialNumber(dialNumber)

    res.type('application/xml').send(xmlString).end()

    if (verification) {
        await updateVerification(verification.id, callerNumber)
    }

    // delete call log for privacy reason
    deleteCallLog(callSid)
})

// Start server
app.listen(port, () => {
    console.log(`App listening on port ${port}`)
})