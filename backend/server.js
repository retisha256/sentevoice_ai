const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Load env vars
dotenv.config();

const VoiceHandler = require('./services/voiceHandler');
const db = require('./database');

// ==============================
// AFRICA'S TALKING SDK
// ==============================
const AfricasTalking = require('africastalking')({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME
});

const sms = AfricasTalking.SMS;

const app = express();
const PORT = process.env.PORT || 5000;

// ==============================
// ENSURE UPLOADS FOLDER EXISTS
// ==============================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// ==============================
// MIDDLEWARE
// ==============================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadDir));

// ==============================
// SAFE RESPONSE HELPER
// ==============================
function safeSend(res, data, isJson = false) {
  if (!res.headersSent) {
    if (isJson) {
      return res.json(data);
    }
    return res.send(data);
  }
  console.warn('⚠ Response already sent');
}

// ==============================
// MULTER SETUP
// ==============================
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// ==============================
// VOICE CALLBACK
// ==============================
app.post('/voice/callback', upload.single('recording'), async (req, res) => {
  try {
    console.log('📞 Voice callback:', req.body);

    const { phoneNumber, callSessionState } = req.body;

    if (callSessionState === 'New') {
      return safeSend(res, {
        actions: [
          {
            say: "Welcome to SenteVoice AI. Please speak your transaction after the beep."
          },
          {
            record: true,
            maxLength: 30,
            transcription: true
          }
        ]
      }, true);
    }

    if (callSessionState === 'Recording' && req.file) {
      const recordingUrl =
        req.body.recordingUrl ||
        `/uploads/${req.file.filename}`;

      const result = await VoiceHandler.processVoiceCall(
        recordingUrl,
        phoneNumber
      );

      const message = result.success
        ? `${result.action} of ${result.amount} shillings recorded. Balance is ${result.balance}.`
        : `Sorry, ${result.error}`;

      return safeSend(res, {
        actions: [
          { say: message },
          { hangup: true }
        ]
      }, true);
    }

    return safeSend(res, {
      actions: [
        { say: "Thank you for using SenteVoice AI." },
        { hangup: true }
      ]
    }, true);

  } catch (error) {
    console.error('Voice callback error:', error);

    return safeSend(res, {
      actions: [
        { say: "Technical error. Please try later." },
        { hangup: true }
      ]
    }, true);
  }
});

// ==============================
// USSD CALLBACK
// ==============================
app.post('/ussd/callback', (req, res) => {
  console.log('USSD Request:', req.body);

  const { phoneNumber, text = '' } = req.body;
  const input = text.split('*');

  const send = (msg) => safeSend(res, msg);

  try {
    if (text === '') {
      return send(
        'CON Welcome to SenteVoice AI\n' +
        '1. Check Balance\n' +
        '2. Register\n' +
        '3. Get Help'
      );
    }

    else if (input[0] === '1') {
      return db.get(
        'SELECT * FROM members WHERE phone = ?',
        [phoneNumber],
        (err, member) => {
          if (err) {
            console.error(err);
            return send('END Database error.');
          }

          if (!member) {
            return send(
              'END No account found. Register first.'
            );
          }

          return send(
            `END Balance: ${member.balance || 0} UGX\n` +
            `Savings: ${member.total_savings || 0} UGX\n` +
            `Loans: ${member.total_loans || 0} UGX`
          );
        }
      );
    }

    else if (input[0] === '2') {
      if (input.length === 1) {
        return send('CON Enter your full name:');
      }

      const name = input[1]?.trim() || '';

      if (!name) {
        return send('END Invalid name.');
      }

      return db.run(
        `INSERT OR IGNORE INTO members
         (name, phone, group_id)
         VALUES (?, ?, ?)`,
        [name, phoneNumber, 1],
        function (err) {
          if (err) {
            console.error(err);
            return send('END Registration failed.');
          }

          if (this.changes === 0) {
            return send('END Already registered.');
          }

          return send(
            `END Registration successful!\nWelcome ${name}.`
          );
        }
      );
    }

    else if (input[0] === '3') {
      return send(
        'END SenteVoice AI Help:\n' +
        'Call voice hotline to record transactions.\n' +
        'Commands: Savings X, Loan X, Balance'
      );
    }

    return send('END Invalid option.');

  } catch (error) {
    console.error('USSD Error:', error);
    return send('END Technical error.');
  }
});

// ==============================
// SMS CALLBACK
// ==============================
app.post('/sms/callback', (req, res) => {
  safeSend(res, '', false);

  const { from, text } = req.body;

  if (!from || !text) return;

  console.log(`📱 SMS from ${from}: ${text}`);

  if (text.toLowerCase().includes('balance')) {
    db.get(
      'SELECT * FROM members WHERE phone = ?',
      [from],
      async (err, member) => {
        let message;

        if (err || !member) {
          message = 'No account found. Register via USSD.';
        } else {
          message =
            `Balance: ${member.balance} UGX | ` +
            `Savings: ${member.total_savings} UGX | ` +
            `Loans: ${member.total_loans} UGX`;
        }

        try {
          await sms.send({
            to: [from],
            message
          });
        } catch (err) {
          console.error('SMS send error:', err.message);
        }
      }
    );
  }
});

// ==============================
// API ROUTES
// ==============================
app.get('/api/members', (req, res) => {
  db.all('SELECT * FROM members', (err, rows) => {
    if (err) {
      return safeSend(res, { error: err.message }, true);
    }
    return safeSend(res, rows, true);
  });
});

app.get('/api/members/:id', (req, res) => {
  const memberId = req.params.id;

  db.get(
    'SELECT * FROM members WHERE id = ?',
    [memberId],
    (err, member) => {
      if (err || !member) {
        return safeSend(res, {
          error: 'Member not found'
        }, true);
      }

      db.all(
        `SELECT * FROM transactions
         WHERE member_id = ?
         ORDER BY recorded_at DESC
         LIMIT 10`,
        [memberId],
        (err, transactions) => {
          if (err) {
            return safeSend(res, {
              error: err.message
            }, true);
          }

          return safeSend(res, {
            ...member,
            transactions
          }, true);
        }
      );
    }
  );
});

app.get('/api/stats', (req, res) => {
  db.get(
    `SELECT
      COUNT(*) as total_members,
      SUM(balance) as total_balance,
      SUM(total_savings) as total_savings
     FROM members`,
    (err, stats) => {
      if (err) {
        return safeSend(res, {
          error: err.message
        }, true);
      }
      return safeSend(res, stats, true);
    }
  );
});

// ==============================
// HEALTH
// ==============================
app.get('/health', (req, res) => {
  safeSend(res, {
    status: '✅ SenteVoice AI running'
  }, true);
});

// ==============================
// GLOBAL ERROR HANDLERS
// ==============================
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

// ==============================
// START SERVER
// ==============================
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`Voice: http://localhost:${PORT}/voice/callback`);
  console.log(`USSD: http://localhost:${PORT}/ussd/callback`);
  console.log(`SMS: http://localhost:${PORT}/sms/callback`);
});