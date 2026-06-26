const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');
const VoiceHandler = require('./services/voiceHandler');
const db = require('./database');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer setup for audio uploads
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// ============================================
// AFRICA'S TALKING VOICE WEBHOOK
// ============================================
app.post('/voice/callback', upload.single('recording'), async (req, res) => {
  try {
    console.log('📞 Voice call received:', req.body);

    const { phoneNumber, callSessionState } = req.body;

    // Handle new call
    if (callSessionState === 'New') {
      return res.json({
        actions: [
          {
            say: "Welcome to SenteVoice AI. Please speak your transaction after the beep. For example: Nakato contributed 10,000 shillings to savings."
          },
          {
            record: true,
            maxLength: 30,
            transcription: true
          }
        ]
      });
    }

    // Handle recording
    if (callSessionState === 'Recording' && req.file) {
      const recordingUrl = req.body.recordingUrl || `/uploads/${req.file.filename}`;

      // Process the voice recording
      const result = await VoiceHandler.processVoiceCall(
        recordingUrl,
        phoneNumber
      );

      // Send voice response
      let responseMessage = result.success
        ? `${result.action} of ${result.amount} shillings recorded. Your balance is ${result.balance} shillings. Check your SMS for details.`
        : `Sorry, ${result.error}. Please try again.`;

      return res.json({
        actions: [
          { say: responseMessage },
          { hangup: true }
        ]
      });
    }

    // Default response
    res.json({
      actions: [
        { say: "Thank you for using SenteVoice AI. Goodbye." },
        { hangup: true }
      ]
    });

  } catch (error) {
    console.error('Voice callback error:', error);
    res.json({
      actions: [
        { say: "We're experiencing technical difficulties. Please try again later." },
        { hangup: true }
      ]
    });
  }
});

// ============================================
// USSD WEBHOOK (Balance Check)
// ============================================
app.post('/ussd/callback', async (req, res) => {
  try {
    const { sessionId, phoneNumber, text } = req.body;

    let response = '';
    const input = text.split('*');

    if (text === '') {
      // Main menu
      response = 'CON Welcome to SenteVoice AI\n';
      response += '1. Check Balance\n';
      response += '2. Register\n';
      response += '3. Get Help\n';
    } else if (input[0] === '1') {
      // Balance check
      db.get('SELECT * FROM members WHERE phone = ?', [phoneNumber], (err, member) => {
        if (err || !member) {
          response = 'END No account found. Please register first.';
        } else {
          response = `END Balance: ${member.balance} UGX\nSavings: ${member.total_savings} UGX\nLoans: ${member.total_loans} UGX`;
        }
        res.send(response);
        return;
      });
    } else if (input[0] === '2') {
      // Registration
      if (input.length === 1) {
        response = 'CON Enter your full name:';
      } else {
        const name = input[1];
        db.run('INSERT INTO members (name, phone, group_id) VALUES (?, ?, ?)',
          [name, phoneNumber, 1],
          function(err) {
            if (err) {
              response = 'END Registration failed. Please try again.';
            } else {
              response = `END ✅ Registration successful! Welcome ${name}.`;
            }
            res.send(response);
            return;
          }
        );
      }
    } else if (input[0] === '3') {
      response = 'END SenteVoice AI Help:\nCall our voice hotline to transact.\nSay "Savings X", "Loan X", or "Balance".\nSMS receipts sent after each transaction.';
    } else {
      response = 'END Invalid option. Please try again.';
    }

    res.send(response);

  } catch (error) {
    console.error('USSD callback error:', error);
    res.send('END Technical error. Please try again.');
  }
});

// ============================================
// SMS WEBHOOK (Receive SMS)
// ============================================
app.post('/sms/callback', async (req, res) => {
  try {
    const { from, text } = req.body;
    console.log(`📱 SMS from ${from}: ${text}`);

    // Simple SMS response
    let reply = "Thank you for contacting SenteVoice AI. Call our voice hotline for transactions.";

    if (text.toLowerCase().includes('balance')) {
      db.get('SELECT * FROM members WHERE phone = ?', [from], (err, member) => {
        if (err || !member) {
          reply = 'No account found. Register via USSD *123#';
        } else {
          reply = `Balance: ${member.balance} UGX | Savings: ${member.total_savings} UGX | Loans: ${member.total_loans} UGX`;
        }
        res.send(reply);
        return;
      });
    } else {
      res.send(reply);
    }

  } catch (error) {
    console.error('SMS callback error:', error);
    res.send('Technical error. Please try again.');
  }
});

// ============================================
// API ENDPOINTS FOR DASHBOARD
// ============================================

// Get all members
app.get('/api/members', (req, res) => {
  db.all('SELECT * FROM members', (err, members) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(members);
  });
});

// Get member details with transactions
app.get('/api/members/:id', (req, res) => {
  const memberId = req.params.id;

  db.get('SELECT * FROM members WHERE id = ?', [memberId], (err, member) => {
    if (err || !member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    db.all('SELECT * FROM transactions WHERE member_id = ? ORDER BY recorded_at DESC LIMIT 10',
      [memberId],
      (err, transactions) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        res.json({ ...member, transactions });
      }
    );
  });
});

// Get summary stats
app.get('/api/stats', (req, res) => {
  db.get('SELECT COUNT(*) as total_members, SUM(balance) as total_balance, SUM(total_savings) as total_savings FROM members',
    (err, stats) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json(stats);
    }
  );
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: '✅ SenteVoice AI is running!' });
});

// Start server
app.listen(PORT, () => {
  console.log(` SenteVoice AI Server running on port ${PORT}`);
  console.log(` Voice webhook: http://localhost:${PORT}/voice/callback`);
  console.log(` USSD webhook: http://localhost:${PORT}/ussd/callback`);
  console.log(` SMS webhook: http://localhost:${PORT}/sms/callback`);
  console.log(` Dashboard API: http://localhost:${PORT}/api`);
});