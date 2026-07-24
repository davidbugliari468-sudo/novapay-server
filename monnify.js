const axios = require("axios");

const BASE_URL = process.env.MONNIFY_BASE_URL;
const API_KEY = process.env.MONNIFY_API_KEY;
const SECRET_KEY = process.env.MONNIFY_SECRET_KEY;
const CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;

async function getAccessToken() {

    const auth = Buffer.from(
        `${API_KEY}:${SECRET_KEY}`
    ).toString("base64");

    const response = await axios.post(
        `${BASE_URL}/api/v1/auth/login`,
        {},
        {
            headers: {
                Authorization: `Basic ${auth}`
            }
        }
    );

    if (!response.data.requestSuccessful) {
        throw new Error("Monnify authentication failed.");
    }

    return response.data.responseBody.accessToken;

}

module.exports = {
    getAccessToken,
    CONTRACT_CODE,
    BASE_URL
};