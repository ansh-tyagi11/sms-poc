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
const MAX_BODY_SIZE = '100kb';
const CONCURRENCY_LIMIT = 20;
const VALID_CHANNELS = new Set(['sms', 'whatsapp', 'both']);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || process.env.ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || process.env.AUTH_TOKEN;
const SERVICE_SID = process.env.SERVICE_SID;

const WHATSAPP_360_API_KEY = process.env.WHATSAPP_360_API_KEY;
const WHATSAPP_360_API_URL = process.env.WHATSAPP_360_API_URL || 'https://waba-v2.360dialog.io';

const SMSALA_API_TOKEN = process.env.SMSALA_API_TOKEN;
const SMSALA_SENDER_ID = process.env.SMSALA_SENDER_ID || 'TSTALA';
const SMSALA_API_URL = process.env.SMSALA_API_URL || 'https://api2.smsala.com/SendSmsV2';

const SMSALA_MESSAGE_TYPE = process.env.SMSALA_MESSAGE_TYPE || '1';

const SMSALA_MESSAGE_ENCODING = process.env.SMSALA_MESSAGE_ENCODING || '1';
const SMSALA_COUNTRIES = new Set(['GH']);

// SMSala delivery-report callback: SMSala will POST (or GET, depending on their
// setup) status updates to this URL once a message's delivery status changes.
const SMSALA_CALLBACK_URL = process.env.SMSALA_CALLBACK_URL
    || 'https://sms-poc-t1gc.onrender.com/smsala/status';

// Max recipients per single SMSala batch call (comma-separated destinationAddress).
// SMSala's docs don't state a hard cap; 100 is a conservative default.
const SMSALA_BATCH_SIZE = Number(process.env.SMSALA_BATCH_SIZE) || 100;

const NOTIFY_PHONE_NUMBER = process.env.NOTIFY_PHONE_NUMBER || '';
const NO_TWO_WAY_SMS_COUNTRIES = new Set(['GH', 'NG', 'ET', 'TZ', 'UG']);

const incomingMessages = [];
const MAX_STORED_MESSAGES = 500;

// SMSala delivery-report callbacks get stored here so they can be inspected
// via /smsala/status-log, similar to how incoming messages are tracked.
const smsalaStatusUpdates = [];
const MAX_STORED_STATUS_UPDATES = 500;

if (!ACCOUNT_SID || !AUTH_TOKEN || !SERVICE_SID) {
    throw new Error(
        'Missing required Twilio environment variables. ' +
        'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and SERVICE_SID.'
    );
}

if (!WHATSAPP_360_API_KEY) {
    console.warn(
        'WHATSAPP_360_API_KEY is not set. WhatsApp sends and the /webhooks/whatsapp ' +
        'route will still run, but outbound WhatsApp messages will fail until it is configured.'
    );
}

if (!SMSALA_API_TOKEN) {
    console.warn(
        'SMSALA_API_TOKEN is not set. Ghana SMS sends will fail ' +
        'until this is configured (Ghana traffic will not fall back to Twilio automatically).'
    );
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const limit = pLimit(CONCURRENCY_LIMIT);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE_BYTES
    }
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(express.urlencoded({ extended: false, limit: MAX_BODY_SIZE }));
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));

function normalizeChannel(channel) {
    const normalized = String(channel || 'sms').trim().toLowerCase();
    if (!VALID_CHANNELS.has(normalized)) {
        throw new Error('Channel must be one of SMS, WhatsApp, or Both.');
    }
    return normalized;
}

function normalizeContactValue(value) {
    return String(value || '').trim();
}

function pickRowValue(row, keys) {
    for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
            return row[key];
        }
    }
    return '';
}

function detectCountryCode(phoneNumber) {

    const prefixMap = [
        { prefix: '+233', code: 'GH' }, // Ghana
        { prefix: '+234', code: 'NG' }, // Nigeria
        { prefix: '+251', code: 'ET' }, // Ethiopia
        { prefix: '+255', code: 'TZ' }, // Tanzania
        { prefix: '+256', code: 'UG' }, // Uganda
        { prefix: '+1', code: 'US' }, // USA / Canada
        { prefix: '+44', code: 'GB' }, // UK
        { prefix: '+61', code: 'AU' }, // Australia
        { prefix: '+91', code: 'IN' }, // India
        { prefix: '+49', code: 'DE' }, // Germany
        { prefix: '+33', code: 'FR' }, // France
    ];

    const clean = phoneNumber.replace(/^whatsapp:/i, '');
    for (const entry of prefixMap) {
        if (clean.startsWith(entry.prefix)) {
            return entry.code;
        }
    }
    return 'UNKNOWN';
}

function isTwoWaySmsSupported(phoneNumber) {
    const countryCode = detectCountryCode(phoneNumber);
    return !NO_TWO_WAY_SMS_COUNTRIES.has(countryCode);
}

function readContactsFromBuffer(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    if (!workbook.SheetNames.length) {
        throw new Error('The uploaded Excel file does not contain any sheets.');
    }
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    if (!rows.length) {
        throw new Error('The uploaded Excel sheet does not contain any rows.');
    }
    return rows.map(row => ({
        NAME: normalizeContactValue(pickRowValue(row, ['NAME', 'Name', 'name'])) || 'Unknown',
        CONTACT: normalizeContactValue(pickRowValue(row, ['CONTACT', 'Contact', 'contact', 'PHONE', 'Phone', 'phone', 'MOBILE', 'Mobile', 'mobile']))
    }));
}

function buildWebhookTwiML() {
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function sendJsonError(res, statusCode, message) {
    return res.status(statusCode).json({ message });
}

function storeIncomingMessage(data) {
    incomingMessages.unshift(data);
    if (incomingMessages.length > MAX_STORED_MESSAGES) {
        incomingMessages.length = MAX_STORED_MESSAGES;
    }
}

function storeSmsalaStatusUpdate(data) {
    smsalaStatusUpdates.unshift(data);
    if (smsalaStatusUpdates.length > MAX_STORED_STATUS_UPDATES) {
        smsalaStatusUpdates.length = MAX_STORED_STATUS_UPDATES;
    }
}

// ---------------------------------------------------------------------------
// Outbound sending: SMS -> Twilio (or SMSala for Ghana), WhatsApp -> 360dialog
// ---------------------------------------------------------------------------

async function sendViaTwilioSms(user, messageBody) {
    const name = user.NAME || 'Unknown';
    const rawContact = user.CONTACT;
    console.log(`Sending SMS to ${name} (${rawContact}) via Twilio`);

    try {
        const recipient = normalizeContactValue(rawContact).replace(/^whatsapp:/i, '');
        if (!recipient) {
            throw new Error('Contact number is missing.');
        }
        const message = await client.messages.create({
            body: messageBody,
            messagingServiceSid: SERVICE_SID,
            to: recipient,
            statusCallback: 'https://sms-poc-t1gc.onrender.com/twilio/status'
        });
        return {
            name,
            contact: rawContact,
            channel: 'sms',
            sid: message.sid,
            status: message.status
        };
    } catch (error) {
        console.error(`Error sending SMS to ${name} (${rawContact}): ${error.message}`);
        return {
            name,
            contact: rawContact,
            channel: 'sms',
            error: error.message
        };
    }
}

function toSmsalaNumber(rawContact) {
    const cleaned = normalizeContactValue(rawContact).replace(/^whatsapp:/i, '');
    const digitsOnly = cleaned.replace(/[^\d]/g, '');
    if (!digitsOnly) {
        throw new Error('Contact number is missing or invalid.');
    }
    return digitsOnly;
}

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// Sends to a batch of Ghana recipients in ONE SMSala API call, using the
// documented comma-separated destinationAddress format:
//   destinationAddress=233...,233...,233...
// SMSala returns an array of result objects in the same order as the
// destinationAddress list, which we zip back to the original users.
async function sendViaSmsalaBatch(users, messageBody) {
    if (!SMSALA_API_TOKEN) {
        return users.map(user => ({
            name: user.NAME || 'Unknown',
            contact: user.CONTACT,
            channel: 'sms',
            error: 'SMSala API credentials are not configured (set SMSALA_API_TOKEN).'
        }));
    }

    const results = [];

    for (const batch of chunkArray(users, SMSALA_BATCH_SIZE)) {
        const validEntries = [];
        for (const user of batch) {
            try {
                const destination = toSmsalaNumber(user.CONTACT);
                validEntries.push({ user, destination });
            } catch (error) {
                results.push({
                    name: user.NAME || 'Unknown',
                    contact: user.CONTACT,
                    channel: 'sms',
                    error: error.message
                });
            }
        }

        if (!validEntries.length) continue;

        const destinationAddress = validEntries.map(e => e.destination).join(',');
        const userReferenceId = `${Date.now()}-batch`;
        const params = new URLSearchParams({
            apiToken: SMSALA_API_TOKEN,
            messageType: SMSALA_MESSAGE_TYPE,
            messageEncoding: SMSALA_MESSAGE_ENCODING,
            destinationAddress,
            sourceAddress: SMSALA_SENDER_ID,
            messageText: messageBody,
            callBackUrl: SMSALA_CALLBACK_URL,
            userReferenceId
        });

        console.log(`Sending SMSala batch of ${validEntries.length} recipient(s) via SMSala (Ghana)`);

        try {
            const response = await fetch(`${SMSALA_API_URL}?${params.toString()}`, { method: 'GET' });
            const data = await response.json().catch(() => ({}));

            console.log("HTTP Status:", response.status);
            console.log("SMSala Response:");
            console.log(JSON.stringify(data, null, 2));

            const resultList = Array.isArray(data) ? data : [data];

            validEntries.forEach((entry, index) => {
                const result = resultList[index];
                const name = entry.user.NAME || 'Unknown';
                if (!response.ok || !result || result.Status !== 'Success') {
                    const errMsg = result?.Remarks || `SMSala request failed with status ${response.status}`;
                    console.error(`Error sending SMS to ${name} (${entry.user.CONTACT}) via SMSala: ${errMsg}`);
                    results.push({
                        name,
                        contact: entry.user.CONTACT,
                        channel: 'sms',
                        error: errMsg
                    });
                } else {
                    results.push({
                        name,
                        contact: entry.user.CONTACT,
                        channel: 'sms',
                        sid: result.MessageId != null ? String(result.MessageId) : null,
                        status: 'submitted',
                        userReferenceId
                    });
                }
            });
        } catch (error) {
            console.error(`SMSala batch request failed: ${error.message}`);
            for (const entry of validEntries) {
                results.push({
                    name: entry.user.NAME || 'Unknown',
                    contact: entry.user.CONTACT,
                    channel: 'sms',
                    error: error.message
                });
            }
        }
    }

    return results;
}

function to360WhatsAppNumber(rawContact) {
    const cleaned = normalizeContactValue(rawContact).replace(/^whatsapp:/i, '');
    const digitsOnly = cleaned.replace(/[^\d]/g, '');
    if (!digitsOnly) {
        throw new Error('Contact number is missing or invalid.');
    }
    return digitsOnly;
}

async function sendViaWhatsApp360(user, messageBody) {
    const name = user.NAME || 'Unknown';
    const rawContact = user.CONTACT;
    console.log(`Sending WhatsApp to ${name} (${rawContact}) via 360dialog`);

    try {
        if (!WHATSAPP_360_API_KEY) {
            throw new Error('360dialog API key is not configured (set WHATSAPP_360_API_KEY).');
        }
        const to = to360WhatsAppNumber(rawContact);
        const response = await fetch(`${WHATSAPP_360_API_URL}/messages`, {
            method: 'POST',
            headers: {
                'D360-API-KEY': WHATSAPP_360_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to,
                type: 'text',
                text: { body: messageBody }
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const errMsg = data?.error?.message
                || data?.errors?.[0]?.title
                || `360dialog request failed with status ${response.status}`;
            throw new Error(errMsg);
        }

        const messageId = data?.messages?.[0]?.id || null;
        return {
            name,
            contact: rawContact,
            channel: 'whatsapp',
            sid: messageId,
            status: 'accepted'
        };
    } catch (error) {
        console.error(`Error sending WhatsApp to ${name} (${rawContact}): ${error.message}`);
        return {
            name,
            contact: rawContact,
            channel: 'whatsapp',
            error: error.message
        };
    }
}

function createCancellationState(req) {
    const state = { cancelled: false };
    const markCancelled = () => { state.cancelled = true; };
    req.on('aborted', markCancelled);
    req.on('close', () => { if (!req.complete) markCancelled(); });
    return state;
}

// SMS is split: Ghana recipients go out in batched SMSala calls (one HTTP
// request per up-to-SMSALA_BATCH_SIZE numbers); everyone else goes through
// Twilio per-recipient, same as before. WhatsApp stays per-recipient via
// 360dialog, since that API doesn't support a comma-separated multi-send.
async function sendBulkMessages(users, messageBody, channel, cancellationState) {
    const channelsToSend = channel === 'both' ? ['sms', 'whatsapp'] : [channel];
    const results = [];

    for (const selectedChannel of channelsToSend) {
        if (cancellationState.cancelled) break;

        if (selectedChannel === 'sms') {
            const ghanaUsers = [];
            const otherUsers = [];
            for (const user of users) {
                const countryCode = detectCountryCode(normalizeContactValue(user.CONTACT));
                (SMSALA_COUNTRIES.has(countryCode) ? ghanaUsers : otherUsers).push(user);
            }

            if (ghanaUsers.length && !cancellationState.cancelled) {
                const batchResults = await sendViaSmsalaBatch(ghanaUsers, messageBody);
                results.push(...batchResults);
            }

            const twilioTasks = otherUsers.map(user =>
                limit(async () => {
                    if (cancellationState.cancelled) return null;
                    return sendViaTwilioSms(user, messageBody);
                })
            );
            results.push(...(await Promise.all(twilioTasks)).filter(Boolean));
        } else {
            const waTasks = users.map(user =>
                limit(async () => {
                    if (cancellationState.cancelled) return null;
                    return sendViaWhatsApp360(user, messageBody);
                })
            );
            results.push(...(await Promise.all(waTasks)).filter(Boolean));
        }
    }

    console.log(
        `Finished. Attempts: ${results.length}, ` +
        `Sent: ${results.filter(r => r && r.sid).length}, ` +
        `Failed: ${results.filter(r => r && r.error).length}`
    );
    return results.filter(Boolean);
}

app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.get("/ip", async (req, res) => {
    const response = await fetch("https://api.ipify.org?format=json");
    const data = await response.json();
    res.json(data);
});

app.get('/twilio/incoming-messages', (_req, res) => {
    res.status(200).json({
        count: incomingMessages.length,
        messages: incomingMessages
    });
});

app.post('/twilio/incoming', async (req, res) => {
    res.type('xml');

    const from = normalizeContactValue(req.body?.From);
    const to = normalizeContactValue(req.body?.To);
    const body = normalizeContactValue(req.body?.Body);

    if (!from || !to || !body) {
        return res.status(200).send(buildWebhookTwiML());
    }

    const channel = 'sms';
    const messageSid = normalizeContactValue(req.body?.MessageSid);
    const smsSid = normalizeContactValue(req.body?.SmsSid);
    const accountSid = normalizeContactValue(req.body?.AccountSid);
    const countryCode = detectCountryCode(from);
    const twoWaySupported = isTwoWaySmsSupported(from);

    console.log('Incoming SMS message received');
    console.log(`From: ${from} (Country: ${countryCode})`);
    console.log(`To: ${to}`);
    console.log(`Body: ${body}`);
    console.log(`Two-way SMS supported: ${twoWaySupported}`);
    if (messageSid) console.log(`MessageSid: ${messageSid}`);
    if (smsSid) console.log(`SmsSid: ${smsSid}`);
    if (accountSid) console.log(`AccountSid: ${accountSid}`);

    storeIncomingMessage({
        receivedAt: new Date().toISOString(),
        channel,
        from,
        to,
        body,
        countryCode,
        twoWaySupported,
        messageSid,
        smsSid,
        accountSid
    });

    if (NOTIFY_PHONE_NUMBER && twoWaySupported) {
        try {
            await client.messages.create({
                body: `Reply from ${from} [${countryCode}] via SMS: ${body}`,
                messagingServiceSid: SERVICE_SID,
                to: NOTIFY_PHONE_NUMBER
            });
            console.log(`Reply forwarded to ${NOTIFY_PHONE_NUMBER}`);
        } catch (err) {
            console.error(`Failed to forward reply: ${err.message}`);
        }
    } else if (NOTIFY_PHONE_NUMBER && !twoWaySupported) {
        console.log(`Reply from ${countryCode} stored only — two-way SMS not supported. Check /twilio/incoming-messages`);
    }

    return res.status(200).send(buildWebhookTwiML());
});

app.post('/webhooks/whatsapp', async (req, res) => {
    res.sendStatus(200);

    try {
        const entries = req.body?.entry || [];
        for (const entry of entries) {
            const changes = entry?.changes || [];
            for (const change of changes) {
                const value = change?.value;
                const messages = value?.messages || [];
                const contacts = value?.contacts || [];

                for (const msg of messages) {
                    const from = normalizeContactValue(msg?.from);
                    const body = normalizeContactValue(msg?.text?.body);
                    const messageId = normalizeContactValue(msg?.id);
                    const contactName = contacts.find(c => c?.wa_id === msg?.from)?.profile?.name || '';
                    const fromWithPrefix = `whatsapp:+${from}`;
                    const countryCode = detectCountryCode(fromWithPrefix);
                    const twoWaySupported = isTwoWaySmsSupported(fromWithPrefix);

                    console.log('Incoming WhatsApp message received (360dialog)');
                    console.log(`From: ${from} (${contactName}) [${countryCode}]`);
                    console.log(`Body: ${body}`);
                    if (messageId) console.log(`MessageId: ${messageId}`);

                    storeIncomingMessage({
                        receivedAt: new Date().toISOString(),
                        channel: 'whatsapp',
                        from: fromWithPrefix,
                        to: normalizeContactValue(value?.metadata?.display_phone_number),
                        body,
                        countryCode,
                        twoWaySupported,
                        messageSid: messageId,
                        smsSid: '',
                        accountSid: ''
                    });

                    if (NOTIFY_PHONE_NUMBER && twoWaySupported) {
                        try {
                            await client.messages.create({
                                body: `WhatsApp reply from ${contactName || from} [${countryCode}]: ${body}`,
                                messagingServiceSid: SERVICE_SID,
                                to: NOTIFY_PHONE_NUMBER
                            });
                            console.log(`WhatsApp reply forwarded to ${NOTIFY_PHONE_NUMBER}`);
                        } catch (err) {
                            console.error(`Failed to forward WhatsApp reply: ${err.message}`);
                        }
                    } else if (NOTIFY_PHONE_NUMBER && !twoWaySupported) {
                        console.log(`WhatsApp reply from ${countryCode} stored only — check /twilio/incoming-messages`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error processing 360dialog webhook payload:', error.message);
    }
});

app.post('/twilio/status', (req, res) => {
    const messageSid = normalizeContactValue(req.body?.MessageSid);
    const status = normalizeContactValue(req.body?.MessageStatus);
    const to = normalizeContactValue(req.body?.To);
    const errorCode = normalizeContactValue(req.body?.ErrorCode);
    const errorMessage = normalizeContactValue(req.body?.ErrorMessage);

    console.log(`Status update: ${messageSid} → ${status} (To: ${to})`);
    if (errorCode) {
        console.error(`Delivery error ${errorCode}: ${errorMessage} → To: ${to}`);
    }

    res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// SMSala delivery-report (DLR) callback
// SMSala calls this URL (configured via the callBackUrl param on send) once a
// message's delivery status is known. Handling both POST and GET here since
// gateways vary in how they invoke DLR webhooks.
// ---------------------------------------------------------------------------

function handleSmsalaStatusPayload(payload, method) {
    const messageId = normalizeContactValue(payload?.MessageId ?? payload?.messageId);
    const dlrStatus = normalizeContactValue(payload?.DlrStatus ?? payload?.dlrStatus);
    const destinationAddress = normalizeContactValue(payload?.DestinationAddress ?? payload?.destinationAddress);
    const userReferenceId = normalizeContactValue(payload?.UserReferenceId ?? payload?.userReferenceId);

    console.log(`SMSala DLR callback received (${method}):`, JSON.stringify(payload, null, 2));
    console.log(`SMSala status: MessageId=${messageId} → ${dlrStatus} (To: ${destinationAddress})`);

    storeSmsalaStatusUpdate({
        receivedAt: new Date().toISOString(),
        method,
        messageId,
        dlrStatus,
        destinationAddress,
        userReferenceId,
        raw: payload
    });
}

app.post('/smsala/status', (req, res) => {
    handleSmsalaStatusPayload(req.body, 'POST');
    res.sendStatus(200);
});

app.get('/smsala/status', (req, res) => {
    handleSmsalaStatusPayload(req.query, 'GET');
    res.sendStatus(200);
});

app.get('/smsala/status-log', (_req, res) => {
    res.status(200).json({
        count: smsalaStatusUpdates.length,
        updates: smsalaStatusUpdates
    });
});

app.get('/', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.post('/send-message', upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return sendJsonError(res, 400, 'Please upload an Excel file.');
        }
        const messageBody = String(req.body.message || DEFAULT_MESSAGE).trim();
        const channel = normalizeChannel(req.body.channel);
        if (!messageBody) {
            return sendJsonError(res, 400, 'Message body cannot be empty.');
        }
        const users = readContactsFromBuffer(req.file.buffer);
        const invalidContacts = users.filter(user => !user.CONTACT);
        if (invalidContacts.length) {
            return sendJsonError(res, 400, 'The uploaded Excel file must include a CONTACT column with values.');
        }
        const cancellationState = createCancellationState(req);
        const results = await sendBulkMessages(users, messageBody, channel, cancellationState);
        if (cancellationState.cancelled) return;
        const sentCount = results.filter(result => result.sid).length;
        const failedCount = results.length - sentCount;
        const attemptCount = results.length;
        return res.status(200).json({
            message: `Campaign processed for ${attemptCount} delivery attempt(s) using ${channel.toUpperCase()}.`,
            total: users.length,
            attempts: attemptCount,
            sent: sentCount,
            failed: failedCount,
            channel,
            results
        });
    } catch (error) {
        if (error.code === 'ERR_HTTP_REQUEST_ABORTED') return;
        next(error);
    }
});

app.use((error, _req, res, _next) => {
    const statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
    const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'The uploaded file is too large.'
        : (IS_PRODUCTION && statusCode === 500
            ? 'Something went wrong while processing the request.'
            : error.message || 'Something went wrong while processing the request.');
    res.status(statusCode).json({ message });
});

const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

function shutdown(signal) {
    console.log(`Received ${signal}. Shutting down gracefully.`);
    server.close(() => { process.exit(0); });
    setTimeout(() => {
        console.error('Forced shutdown after timeout.');
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', error => { console.error('Unhandled promise rejection:', error); });
process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});
