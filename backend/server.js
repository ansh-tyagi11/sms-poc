require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const twilio = require('twilio');
const pLimit = require('p-limit');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const DEFAULT_MESSAGE = 'Test campaign';
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || process.env.ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || process.env.AUTH_TOKEN;
const SERVICE_SID = process.env.SERVICE_SID;
const limit = pLimit(20);

if (!ACCOUNT_SID || !AUTH_TOKEN || !SERVICE_SID) {
    throw new Error(
        'Missing required Twilio environment variables. ' +
        'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and SERVICE_SID.'
    );
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE_BYTES
    }
});

app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(FRONTEND_DIR));

function readContactsFromBuffer(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    if (!workbook.SheetNames.length) {
        throw new Error('The uploaded Excel file does not contain any sheets.');
    }

    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        defval: ''
    });

    if (!rows.length) {
        throw new Error('The uploaded Excel sheet does not contain any rows.');
    }

    return rows;
}

async function sendOne(user, messageBody) {

    const name = user.NAME || 'Unknown';
    const rawContact = user.CONTACT;

    try {

        const message = await client.messages.create({
            body: messageBody,
            messagingServiceSid:
                SERVICE_SID,
            to: rawContact
        });

        return {
            name,
            contact: rawContact,
            sid: message.sid,
            status: message.status
        };
    }

    catch (error) {
        return {
            name,
            contact: rawContact,
            error: error.message
        };
    }

}

async function sendBulkMessages(users, messageBody) {

    // remove this later
    const sample = users.slice(0, 50);

    // for production
    // const sample = users;


    const promises = sample.map(user =>

        limit(() =>
            sendOne(user, messageBody)
        )
    );

    const results = await Promise.all(promises);

    return results;
}

app.get('/', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.post('/send-message', upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                message: 'Please upload an Excel file.'
            });
        }

        const messageBody = String(req.body.message || DEFAULT_MESSAGE).trim();

        if (!messageBody) {
            return res.status(400).json({
                message: 'Message body cannot be empty.'
            });
        }

        const users = readContactsFromBuffer(req.file.buffer);
        const results = await sendBulkMessages(users, messageBody);
        const sentCount = results.filter(result => result.sid).length;
        const failedCount = results.length - sentCount;

        return res.json({
            message: `Campaign processed for ${results.length} contact(s).`,
            total: results.length,
            sent: sentCount,
            failed: failedCount,
            results
        });
    } catch (error) {
        next(error);
    }
});

app.use((error, _req, res, _next) => {
    const statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 500;

    res.status(statusCode).json({
        message: error.code === 'LIMIT_FILE_SIZE'
            ? 'The uploaded file is too large.'
            : error.message || 'Something went wrong while processing the request.'
    });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
