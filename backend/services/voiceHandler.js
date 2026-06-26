const axios = require('axios');
const db = require('../database');
const FormData = require('form-data');

// AI Processing Service
class VoiceHandler {
  // Process incoming voice recording
  static async processVoiceCall(recordingUrl, callerNumber) {
    try {
      // Step 1: Download audio from Africa's Talking
      const audioBuffer = await this.downloadAudio(recordingUrl);

      // Step 2: Transcribe with Whisper
      const transcript = await this.transcribeAudio(audioBuffer);

      // Step 3: Parse with LLM
      const parsedData = await this.parseWithLLM(transcript);

      // Step 4: Process transaction
      const result = await this.processTransaction(callerNumber, parsedData);

      // Step 5: Send SMS confirmation
      await this.sendSMS(callerNumber, result);

      return result;
    } catch (error) {
      console.error('Voice processing error:', error);
      throw error;
    }
  }

  // Download audio from Africa's Talking
  static async downloadAudio(url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return response.data;
  }

  // Transcribe audio using OpenAI Whisper
  static async transcribeAudio(audioBuffer) {
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename: 'audio.mp3' });
    formData.append('model', 'whisper-1');
    formData.append('language', 'lg'); // Luganda

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders()
        }
      }
    );

    return response.data.text;
  }

  // Parse natural language with LLM
  static async parseWithLLM(transcript) {
    const prompt = `
      You are a VSLA financial assistant. Parse the following user speech and extract:
      1. Member name
      2. Action type (savings, loan, repayment, or balance)
      3. Amount in UGX (if applicable)
      4. Group name (if mentioned)

      User said: "${transcript}"

      Respond with JSON only:
      {
        "name": "member name or unknown",
        "action": "savings|loan|repayment|balance",
        "amount": 0,
        "group": "group name or unknown"
      }
    `;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a financial assistant for Village Savings and Loan Associations in Uganda.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.choices[0].message.content;
    return JSON.parse(content);
  }

  // Process transaction in database
  static processTransaction(phone, data) {
    return new Promise((resolve, reject) => {
      // Find or create member
      db.get(
        'SELECT * FROM members WHERE phone = ?',
        [phone],
        (err, member) => {
          if (err) return reject(err);

          let memberId;

          if (!member) {
            // Create new member
            db.run(
              'INSERT INTO members (name, phone, group_id, balance) VALUES (?, ?, ?, ?)',
              [data.name || 'Unknown Member', phone, 1, 0],
              function(err) {
                if (err) return reject(err);
                memberId = this.lastID;
                processAction(memberId);
              }
            );
          } else {
            memberId = member.id;
            processAction(memberId);
          }
        }
      );

      const processAction = (memberId) => {
        const actions = {
          savings: this.handleSavings,
          loan: this.handleLoan,
          repayment: this.handleRepayment,
          balance: this.handleBalance
        };

        const handler = actions[data.action] || this.handleUnknown;
        handler(memberId, data, (result) => resolve(result));
      };
    });
  }

  // Handle savings transaction
  static handleSavings(memberId, data, callback) {
    db.run(
      'UPDATE members SET balance = balance + ?, total_savings = total_savings + ? WHERE id = ?',
      [data.amount, data.amount, memberId],
      function(err) {
        if (err) return callback({ error: 'Transaction failed' });

        db.run(
          'INSERT INTO transactions (member_id, type, amount, description) VALUES (?, ?, ?, ?)',
          [memberId, 'savings', data.amount, 'Voice deposit'],
          function(err) {
            if (err) return callback({ error: 'Transaction log failed' });

            db.get('SELECT * FROM members WHERE id = ?', [memberId], (err, member) => {
              if (err) return callback({ error: 'Failed to fetch balance' });
              callback({
                success: true,
                action: 'savings',
                amount: data.amount,
                balance: member.balance,
                message: `✅ Savings of ${data.amount} UGX recorded. New balance: ${member.balance} UGX`
              });
            });
          }
        );
      }
    );
  }

  // Handle loan transaction
  static handleLoan(memberId, data, callback) {
    // Check if member has enough balance for loan
    db.get('SELECT balance FROM members WHERE id = ?', [memberId], (err, member) => {
      if (err) return callback({ error: 'Failed to check balance' });

      const maxLoan = member.balance * 2; // Can borrow up to 2x savings

      if (data.amount > maxLoan) {
        return callback({
          error: `Loan limit exceeded. Max loan: ${maxLoan} UGX. Your balance: ${member.balance} UGX`
        });
      }

      db.run(
        'UPDATE members SET balance = balance - ?, total_loans = total_loans + ? WHERE id = ?',
        [data.amount, data.amount, memberId],
        function(err) {
          if (err) return callback({ error: 'Transaction failed' });

          db.run(
            'INSERT INTO transactions (member_id, type, amount, description) VALUES (?, ?, ?, ?)',
            [memberId, 'loan', data.amount, 'Voice loan'],
            function(err) {
              if (err) return callback({ error: 'Transaction log failed' });

              db.get('SELECT * FROM members WHERE id = ?', [memberId], (err, member) => {
                if (err) return callback({ error: 'Failed to fetch balance' });
                callback({
                  success: true,
                  action: 'loan',
                  amount: data.amount,
                  balance: member.balance,
                  message: `✅ Loan of ${data.amount} UGX approved. New balance: ${member.balance} UGX`
                });
              });
            }
          );
        }
      );
    });
  }

  // Handle repayment
  static handleRepayment(memberId, data, callback) {
    db.run(
      'UPDATE members SET balance = balance + ? WHERE id = ?',
      [data.amount, memberId],
      function(err) {
        if (err) return callback({ error: 'Transaction failed' });

        db.run(
          'INSERT INTO transactions (member_id, type, amount, description) VALUES (?, ?, ?, ?)',
          [memberId, 'repayment', data.amount, 'Voice repayment'],
          function(err) {
            if (err) return callback({ error: 'Transaction log failed' });

            db.get('SELECT * FROM members WHERE id = ?', [memberId], (err, member) => {
              if (err) return callback({ error: 'Failed to fetch balance' });
              callback({
                success: true,
                action: 'repayment',
                amount: data.amount,
                balance: member.balance,
                message: `✅ Repayment of ${data.amount} UGX recorded. New balance: ${member.balance} UGX`
              });
            });
          }
        );
      }
    );
  }

  // Handle balance check
  static handleBalance(memberId, data, callback) {
    db.get('SELECT * FROM members WHERE id = ?', [memberId], (err, member) => {
      if (err) return callback({ error: 'Failed to fetch balance' });
      callback({
        success: true,
        action: 'balance',
        balance: member.balance,
        totalSavings: member.total_savings,
        totalLoans: member.total_loans,
        message: `💰 Your balance: ${member.balance} UGX. Total savings: ${member.total_savings} UGX. Total loans: ${member.total_loans} UGX`
      });
    });
  }

  // Handle unknown action
  static handleUnknown(memberId, data, callback) {
    callback({
      error: "I didn't understand that. Please say 'Savings', 'Loan', 'Repayment', or 'Balance'."
    });
  }

  // Send SMS via Africa's Talking
  static async sendSMS(phoneNumber, result) {
    try {
      const message = result.success ? result.message : `❌ Error: ${result.error}`;

      const response = await axios.post(
        'https://api.africastalking.com/version1/messaging',
        new URLSearchParams({
          username: process.env.AT_USERNAME,
          to: phoneNumber,
          message: message,
          from: 'SenteVoice'
        }),
        {
          headers: {
            'apiKey': process.env.AT_API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      console.log('SMS sent successfully:', response.data);
    } catch (error) {
      console.error('SMS sending failed:', error.message);
    }
  }
}

module.exports = VoiceHandler;