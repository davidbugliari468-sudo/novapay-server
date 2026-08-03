require("dotenv").config();

const axios = require("axios");

const VTU_BASE_URL = "https://vtu.ng/wp-json";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getVTUToken() {

    try {

        if (
            cachedToken &&
            Date.now() < tokenExpiresAt
        ) {

            return cachedToken;

        }

        const response = await axios.post(

            `${VTU_BASE_URL}/jwt-auth/v1/token`,

            {
                username: process.env.VTU_USERNAME,
                password: process.env.VTU_PASSWORD
            },

            {
                headers: {
                    "Content-Type": "application/json"
                }
            }

        );

        cachedToken = response.data.token;

        // Refresh after 6 days (token is valid for 7 days)
        tokenExpiresAt =
            Date.now() + (6 * 24 * 60 * 60 * 1000);

        return cachedToken;

    } catch (error) {

        console.error(
            "VTU Authentication Error:",
            error.response?.data || error.message
        );

        throw error;

    }

}

module.exports = {

    getVTUToken,
    VTU_BASE_URL

};