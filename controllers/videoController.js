const videoController = require("express").Router();
const redisClient = require("../configs/redisClient");
const {openAi, createTranscript, createEmbeddings, chatCompletion} = require("../libraries/openAiLibrary");
const pineconeLibrary = require("../libraries/pineconeLibrary");
const uploadMiddleware = require("../middlewares/uploadMiddleware");
const fs = require("fs");
const path = require("path");

videoController.post("/upload", uploadMiddleware.single('file'), async (req, res) => {
    if (req.file) {
        let { filename, size, destination, mimetype } = req.file;
        await redisClient.hset(`video-${filename}`, {
            filename,
            size,
            destination,
            mimetype
        });
        res.status(200).json({
            message: "File has been uploaded."
        });
    } else {
        res.status(400).json({
            message: "Please upload a file."
        });
    }
});

videoController.get("/transcript/:videoId", async (req, res) => {
    let { videoId } = req.params;
    createTranscript(videoId).then(async (response) => {
        await redisClient.hset(`video-${videoId}`, {
            transcript: response.text
        });
        return res.json({ message: "Video transcription completed" }).end();
    }).catch((err) => {
        return res.status(400).json(err).end();
    });

});


videoController.get("/embedding/:videoId", async (req, res) => {
    let { videoId } = req.params;

    createEmbeddings(transcript).then(async (response) => {
        let index = pineconeLibrary.index('video-gpt');
        try{
            let records = [];
            for(let idx of response.data){
                records.push({
                    id: `vec${idx.index}`,
                    values: idx.embedding,
                    metadata: {
                        text: transcript
                    }
                });
            }
            let upStatus = await index.upsert(records);
            return res.json({ message: "embedding completed" }).end();
        }catch(err){
            return res.status(400).json({err}).end();
        };
    }).catch((err) => {
        return res.status(400).json(err).end();
    });

});



videoController.get("/search/:videoId", async (req, res) => {
    let { videoId } = req.params;
    let {question} = req.query;
    let transcript = await redisClient.hget(`video-${videoId}`, 'transcript');
    chatCompletion(transcript, question).then((response)=>{
        res.json(response).end();
    }).catch((err) => {
        return res.status(400).json(err).end();
    });
});




module.exports = videoController;