const express = require('express');
const { protect } = require('../middlewares/auth');
const { resolveAccountNumber, fetchBankList, NIGERIAN_BANKS } = require('../utils/paystackService');

const maskAccountNumber = (accountNumber) => {
  if (!accountNumber) return null;
  return '******' + accountNumber.slice(-4);
};

const createBankVerificationRoutes = (Model, role) => {
  const router = express.Router();

  router.use(protect);

  router.get('/banks', async (req, res) => {
    try {
      const banks = await fetchBankList();
      res.json(banks);
    } catch (err) {
      res.json(NIGERIAN_BANKS);
    }
  });

  router.get('/', async (req, res) => {
    try {
      if (req.user.role !== role) return res.status(403).json({ message: 'Forbidden' });

      const account = await Model.findById(req.user.id);
      if (!account) return res.status(404).json({ message: 'Account not found' });

      if (!account.bankVerified) {
        return res.json({ bankVerified: false, message: 'No bank account verified yet.' });
      }

      res.json({
        bankVerified: account.bankVerified,
        bankAccountName: account.bankAccountName,
        bankAccountNumber: maskAccountNumber(account.bankAccountNumber),
        bankCode: account.bankCode,
        bankName: account.bankName,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/resolve', async (req, res) => {
    try {
      if (req.user.role !== role) return res.status(403).json({ message: 'Forbidden' });

      const { accountNumber, bankCode } = req.body;
      if (!accountNumber || !bankCode) {
        return res.status(400).json({ message: 'accountNumber and bankCode are required.' });
      }
      if (!/^\d{10}$/.test(accountNumber)) {
        return res.status(400).json({ message: 'Account number must be exactly 10 digits.' });
      }

      const result = await resolveAccountNumber(accountNumber, bankCode);
      res.json({
        accountName: result.accountName,
        accountNumber: result.accountNumber,
        bankCode: result.bankCode,
        bankName: result.bankName,
        message: 'Account resolved. Please confirm this is correct before saving.',
      });
    } catch (err) {
      res.status(422).json({ message: err.message });
    }
  });

  router.post('/save', async (req, res) => {
    try {
      if (req.user.role !== role) return res.status(403).json({ message: 'Forbidden' });

      const { accountNumber, bankCode } = req.body;
      if (!accountNumber || !bankCode) {
        return res.status(400).json({ message: 'accountNumber and bankCode are required.' });
      }
      if (!/^\d{10}$/.test(accountNumber)) {
        return res.status(400).json({ message: 'Account number must be exactly 10 digits.' });
      }

      const result = await resolveAccountNumber(accountNumber, bankCode);

      const account = await Model.findById(req.user.id);
      if (!account) return res.status(404).json({ message: 'Account not found' });

      account.bankVerified = true;
      account.bankAccountNumber = result.accountNumber;
      account.bankAccountName = result.accountName;
      account.bankCode = result.bankCode;
      account.bankName = result.bankName;
      await account.save();

      res.json({
        message: 'Bank account verified and saved successfully.',
        bankVerified: true,
        bankAccountName: result.accountName,
        bankAccountNumber: maskAccountNumber(result.accountNumber),
        bankName: result.bankName,
      });
    } catch (err) {
      res.status(422).json({ message: err.message });
    }
  });

  router.post('/remove', async (req, res) => {
    try {
      if (req.user.role !== role) return res.status(403).json({ message: 'Forbidden' });

      const account = await Model.findById(req.user.id);
      if (!account) return res.status(404).json({ message: 'Account not found' });

      account.bankVerified = false;
      account.bankAccountNumber = null;
      account.bankAccountName = null;
      account.bankCode = null;
      account.bankName = null;
      await account.save();

      res.json({ message: 'Bank account details removed.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
};

module.exports = { createBankVerificationRoutes };