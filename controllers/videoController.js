const videoController = require("express").Router();
const redisClient = require("../configs/redisClient");
const { openAi, createTranscript, createEmbeddings, chatCompletion } = require("../libraries/openAiLibrary");
const pineconeLibrary = require("../libraries/pineconeLibrary");
const uploadMiddleware = require("../middlewares/uploadMiddleware");
const fs = require("fs");
const path = require("path");


const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);
const Psc = require('pocketsphinx-continuous');

videoController.post("/upload", uploadMiddleware.single('file'), async (req, res) => {
    if (req.file) {
        let { filename, size, destination, mimetype } = req.file;
        let [videoId, ext] = (filename.split("."));
        await redisClient.hset(`video-${videoId}`, {
            video: filename,
            size,
            destination,
            mimetype
        });
        res.status(200).json({
            videoId: videoId,
            message: "File has been uploaded."
        });
    } else {
        res.status(400).json({
            message: "Please upload a file."
        });
    }
});

videoController.get("/convert/:videoId", async (req, res) => {
    let { videoId } = req.params;

    let video = await redisClient.hget(`video-${videoId}`, 'video');
    let inputFile = path.resolve('public', video);
    let outputFile = path.resolve('public', `${videoId}.mp3`);

    ffmpeg().input(inputFile).output(outputFile).audioCodec('libmp3lame').audioBitrate(64).on('end', async () => {
        await redisClient.hset(`video-${videoId}`, {
            audio: `${videoId}.mp3`
        });
        return res.json({
            videoId: videoId,
            message: "Video has been converted into audio format"
        }).end();
    }).on('error', (err) => {
        return res.status(400).json(err).end();
    }).run();
});

videoController.get("/transcript/:videoId", async (req, res) => {
    let { videoId } = req.params;
    let audio = await redisClient.hget(`video-${videoId}`, 'audio');
    createTranscript(audio).then(async (response) => {
        await redisClient.hset(`video-${videoId}`, {
            transcript: response.text
        });
        return res.json({ 
            videoId: videoId,
            message: "Video transcription completed" 
        }).end();
    }).catch((err) => {
        return res.status(400).json(err).end();
    });

});


videoController.get("/embedding/:videoId", async (req, res) => {
    let { videoId } = req.params;


    let transcript = await redisClient.hget(`video-${videoId}`, 'transcript');
    createEmbeddings(transcript).then(async (response) => {
        let index = pineconeLibrary.index('video-gpt');
        try {
            let records = [];
            for (let idx of response.data) {
                records.push({
                    id: `vec${idx.index}`,
                    values: idx.embedding,
                    metadata: {
                        text: transcript
                    }
                });
            }
            let upStatus = await index.upsert(records);
            return res.json({ 
                videoId: videoId,
                message: "embedding completed"
            }).end();
        } catch (err) {
            return res.status(400).json({ err }).end();
        };
    }).catch((err) => {
        return res.status(400).json(err).end();
    });

});



videoController.get("/search/:videoId", async (req, res) => {
    let { videoId } = req.params;
    let { question } = req.query;
    let transcript = await redisClient.hget(`video-${videoId}`, 'transcript');
    chatCompletion(transcript, question).then((response) => {
        res.json(response).end();
    }).catch((err) => {
        return res.status(400).json(err).end();
    });
});




module.exports = videoController;