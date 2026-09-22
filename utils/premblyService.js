const axios = require('axios');

const PREMBLY_BASE_URL = 'https://api.prembly.com/identitypass/verification';

const premblyClient = axios.create({
  baseURL: PREMBLY_BASE_URL,
  headers: {
    'x-api-key': process.env.PREMBLY_API_KEY,
    'app_id': process.env.PREMBLY_APP_ID,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

/**
 * Normalizes Prembly responses into a consistent shape:
 * { verified: bool, data: {}, message: string }
 */
const normalizeResponse = (response, dataKey = null) => {
  const body = response.data;
  const verified = body.status === true || body.verified === true;
  const data = dataKey ? body[dataKey] : body.data || body;
  return { verified, data, message: body.message || '' };
};

/**
 * Verifies a Nigerian NIN (National Identification Number).
 * Returns name, DOB, gender, phone from NIMC database.
 * Uses NIN Basic endpoint — no face comparison.
 */
const verifyNIN = async (nin) => {
  if (!nin || !/^\d{11}$/.test(nin)) {
    throw new Error('NIN must be exactly 11 digits.');
  }

  try {
    const response = await premblyClient.post('/nin', { number: nin });
    const { verified, data, message } = normalizeResponse(response);

    if (!verified) {
      throw new Error(message || 'NIN verification failed. Please check the number and try again.');
    }

    return {
      verified: true,
      nin,
      firstName: data?.firstname || data?.first_name || '',
      lastName: data?.lastname || data?.last_name || '',
      middleName: data?.middlename || data?.middle_name || '',
      dateOfBirth: data?.birthdate || data?.date_of_birth || '',
      gender: data?.gender || '',
      phone: data?.phone || '',
      photo: data?.photo || null, // base64 photo from NIMC
    };
  } catch (err) {
    if (err.response?.status === 400) {
      throw new Error('Invalid NIN. Please check and try again.');
    }
    if (err.response?.status === 402) {
      throw new Error('NIN verification service unavailable. Please try again later.');
    }
    throw new Error(err.message || 'NIN verification failed.');
  }
};

/**
 * Verifies a Nigerian Driver's License.
 * Uses Advance Drivers License endpoint.
 */
const verifyDriversLicense = async (licenseNumber, dateOfBirth) => {
  if (!licenseNumber) throw new Error('Driver\'s license number is required.');
  if (!dateOfBirth) throw new Error('Date of birth is required for license verification.');

  try {
    const response = await premblyClient.post('/drivers_license/advance', {
      number: licenseNumber,
      dob: dateOfBirth, // format: YYYY-MM-DD
    });
    const { verified, data, message } = normalizeResponse(response);

    if (!verified) {
      throw new Error(message || 'Driver\'s license verification failed.');
    }

    return {
      verified: true,
      licenseNumber,
      firstName: data?.first_name || data?.firstname || '',
      lastName: data?.last_name || data?.lastname || '',
      expiryDate: data?.expiry_date || '',
      stateOfIssue: data?.state_of_issue || '',
      vehicleClass: data?.vehicle_class || '',
    };
  } catch (err) {
    if (err.response?.status === 400) {
      throw new Error('Invalid driver\'s license number or date of birth.');
    }
    throw new Error(err.message || 'Driver\'s license verification failed.');
  }
};

/**
 * Verifies a Nigerian CAC (Corporate Affairs Commission) registration.
 * Uses Basic CAC endpoint — returns company name, status, RC number.
 */
const verifyCAC = async (rcNumber) => {
  if (!rcNumber) throw new Error('RC number is required.');

  // RC numbers can be numeric or alphanumeric (e.g. RC123456 or 123456)
  const cleaned = rcNumber.toString().replace(/^RC/i, '').trim();

  try {
    const response = await premblyClient.post('/cac', { rc_number: cleaned });
    const { verified, data, message } = normalizeResponse(response);

    if (!verified) {
      throw new Error(message || 'CAC verification failed. Please check your RC number.');
    }

    return {
      verified: true,
      rcNumber: cleaned,
      companyName: data?.company_name || data?.companyName || '',
      companyStatus: data?.company_status || data?.status || '',
      registrationDate: data?.registration_date || '',
      companyType: data?.company_type || '',
      address: data?.address || '',
    };
  } catch (err) {
    if (err.response?.status === 400) {
      throw new Error('Invalid RC number. Please check and try again.');
    }
    throw new Error(err.message || 'CAC verification failed.');
  }
};

/**
 * Verifies a Nigerian TIN (Tax Identification Number).
 */
const verifyTIN = async (tin) => {
  if (!tin) throw new Error('TIN is required.');

  try {
    const response = await premblyClient.post('/tin', {
      number: tin,
      channel: 'TIN',
    });
    const { verified, data, message } = normalizeResponse(response);

    if (!verified) {
      throw new Error(message || 'TIN verification failed. Please check your TIN.');
    }

    return {
      verified: true,
      tin,
      taxpayerName: data?.taxpayer_name || data?.name || '',
      taxOffice: data?.tax_office || '',
      phone: data?.phone || '',
      email: data?.email || '',
    };
  } catch (err) {
    if (err.response?.status === 400) {
      throw new Error('Invalid TIN. Please check and try again.');
    }
    throw new Error(err.message || 'TIN verification failed.');
  }
};

module.exports = {
  verifyNIN,
  verifyDriversLicense,
  verifyCAC,
  verifyTIN,
};