const OpenAI = require("openai");
const path = require("path");
const fs = require("fs");

const openAiLibrary = new OpenAI({
    organization: process.env.OPENAI_ORG_ID,
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * /createTranscript - create the transcript for a audio file.
 * @param {audio} - audio file name
 * @returns {Promise}
 */
const createTranscript = (audio) => {
    let inputFile = path.resolve('public', audio);
    return openAiLibrary.audio.transcriptions.create({
        file: fs.createReadStream(inputFile),
        model: 'whisper-1'
    });
}

/**
 * /createEmbeddings - create the embeddings for a transcript.
 * @param {text} - text
 * @returns {Promise}
 */
const createEmbeddings = (text) => {
    return openAiLibrary.embeddings.create({
        model: "text-embedding-ada-002",
        input: text,
        encoding_format: "float",
    });
}


/**
 * /chatCompletion - search the answer on behalf of the asked question's related text.
 * @param {content, question} - text, question
 * @returns {Promise}
 */
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