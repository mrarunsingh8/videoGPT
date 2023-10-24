const {Pinecone} = require("@pinecone-database/pinecone");

const pineconeLibrary = new Pinecone({
    environment: process.env.PINECONE_ENVIRONMENT,
    apiKey: process.env.PINECONE_API_KEY
});

module.exports = pineconeLibrary;