const OpenAI = require("openai");
const path = require("path");
const fs = require("fs");

const openAiLibrary = new OpenAI({
    organization: process.env.OPENAI_ORG_ID,
    apiKey: process.env.OPENAI_API_KEY
});

const createTranscript = (videoId) => {
    let inputFile = path.resolve('public', videoId);
    return openAiLibrary.audio.transcriptions.create({
        file: fs.createReadStream(inputFile),
        model: 'whisper-1'
    });
}

const createEmbeddings = (text) => {
    return openAiLibrary.embeddings.create({
        model: "text-embedding-ada-002",
        input: text,
        encoding_format: "float",
    });
}


const chatCompletion = (content, question) => {
    return openAiLibrary.chat.completions.create({
        model: "gpt-3.5-turbo",
        temperature: 0.8,
        messages: [{
            role: "system",
            content: `You are a AI assistant, answer the users question based on the content below\n\n ${content}`
        }, {
            role: "user",
            content: question
        }]
    });
}


module.exports = { openAiLibrary, createTranscript, createEmbeddings, chatCompletion};