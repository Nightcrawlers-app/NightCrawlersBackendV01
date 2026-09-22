const axios = require('axios');

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

const paystackClient = axios.create({
  baseURL: PAYSTACK_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

const NIGERIAN_BANKS = [
  { name: 'Access Bank', code: '044' },
  { name: 'Citibank Nigeria', code: '023' },
  { name: 'Ecobank Nigeria', code: '050' },
  { name: 'Fidelity Bank Nigeria', code: '070' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'First City Monument Bank (FCMB)', code: '214' },
  { name: 'Globus Bank', code: '00103' },
  { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
  { name: 'Heritage Bank', code: '030' },
  { name: 'Keystone Bank', code: '082' },
  { name: 'Kuda Bank', code: '50211' },
  { name: 'Moniepoint Microfinance Bank', code: '50515' },
  { name: 'Opay (OPay Digital Services)', code: '999992' },
  { name: 'Palmpay', code: '999991' },
  { name: 'Polaris Bank', code: '076' },
  { name: 'Providus Bank', code: '101' },
  { name: 'Stanbic IBTC Bank', code: '221' },
  { name: 'Standard Chartered Bank', code: '068' },
  { name: 'Sterling Bank', code: '232' },
  { name: 'Titan Trust Bank', code: '102' },
  { name: 'Union Bank of Nigeria', code: '032' },
  { name: 'United Bank for Africa (UBA)', code: '033' },
  { name: 'Unity Bank', code: '215' },
  { name: 'VFD Microfinance Bank', code: '566' },
  { name: 'Wema Bank', code: '035' },
  { name: 'Zenith Bank', code: '057' },
];

const resolveAccountNumber = async (accountNumber, bankCode) => {
  if (!accountNumber || !bankCode) {
    throw new Error('Account number and bank code are required.');
  }

  const bank = NIGERIAN_BANKS.find((b) => b.code === bankCode);

  try {
    const response = await paystackClient.get('/bank/resolve', {
      params: { account_number: accountNumber, bank_code: bankCode },
    });

    const { account_name, account_number } = response.data.data;

    return {
      accountName: account_name,
      accountNumber: account_number,
      bankCode,
      bankName: bank?.name || 'Unknown Bank',
    };
  } catch (err) {
    const message = err.response?.data?.message || err.message;
    if (err.response?.status === 422) {
      throw new Error('Could not resolve account. Please check the account number and bank.');
    }
    if (err.response?.status === 401) {
      throw new Error('Paystack authentication failed. Check your API key.');
    }
    throw new Error(`Bank verification failed: ${message}`);
  }
};

const fetchBankList = async () => {
  try {
    const response = await paystackClient.get('/bank', {
      params: { currency: 'NGN', per_page: 100 },
    });
    return response.data.data.map((b) => ({ name: b.name, code: b.code }));
  } catch (err) {
    console.error('Failed to fetch live bank list, using static list:', err.message);
    return NIGERIAN_BANKS;
  }
};

module.exports = { resolveAccountNumber, fetchBankList, NIGERIAN_BANKS };