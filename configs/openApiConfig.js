const {OpenAI} = require("openai");

const openApiConfig = new OpenAI({
    organization: process.env.OPENAI_ORG_ID,
    apiKey: process.env.OPENAI_API_KEY
});

module.exports = openApiConfig;