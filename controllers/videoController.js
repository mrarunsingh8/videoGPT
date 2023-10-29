const videoController = require("express").Router();
const redisClient = require("../configs/redisClient");
const { createTranscript, createEmbeddings, chatCompletion } = require("../libraries/openAiLibrary");
const pineconeLibrary = require("../libraries/pineconeLibrary");
const uploadMiddleware = require("../middlewares/uploadMiddleware");
const fs = require("fs");
const path = require("path");
const ytdl = require("ytdl-core");
const uuid = require("uuid");
const moment = require("moment");

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * /ytdl - Accepts and processes an youtube URL.
 *  @body {url} - Youtube URL
 * @returns {Object} - {videoId, message}
 */
videoController.post("/ytdl", async (req, res) => {
    let { url } = req?.body;
    if (url && ytdl.validateURL(url)) {
        let videoId = uuid.v4();
        let dest = moment().format('YYYY-MM-DD');
        const uploadDir = path.resolve('public', dest);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        let inputFile = path.resolve('public', dest, `${videoId}.mp4`);
        ytdl(url, {
            quality: 'lowest',
            filter: format => format.container === 'mp4'
        }).pipe(fs.createWriteStream(inputFile)).on("error", (err) => {
            res.status(400).json({
                err: err
            });
        }).on("finish", async () => {
            await redisClient.hset(`video-${videoId}`, {
                video: `${videoId}.mp4`,
                dest: dest
            });
            res.status(200).json({
                videoId: videoId,
                message: "You tube video has been downloaded."
            });
        });
    } else {
        res.status(400).json({
            message: "Please Enter a valid YouTube URL."
        });
    }
});

/**
 * /upload - Accepts and processes an uploaded file.
 *  @body {file} - multipart
 * @returns {Object} - {videoId, message}
 */
videoController.post("/upload", uploadMiddleware.single('file'), async (req, res) => {
    console.log(req.file);
    if (req.file) {
        let { filename, size, destination, mimetype } = req.file;
        let [videoId, ext] = (filename.split("."));
        await redisClient.hset(`video-${videoId}`, {
            video: filename,
            dest: req.dest,
            size,
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

/**
 * /convert - convert the mp4 file to mp3.
 * @param {videoId} - videoId
 * @returns {Object} - {videoId, message}
 */
videoController.get("/convert/:videoId", async (req, res) => {
    let { videoId } = req.params;

    let video = await redisClient.hget(`video-${videoId}`, 'video');
    let dest = await redisClient.hget(`video-${videoId}`, 'dest');
    let inputFile = path.resolve('public', dest, video);
    let outputFile = path.resolve('public', dest, `${videoId}.mp3`);

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

/**
 * /transcript - get the transcript for the mp3 file.
 * @param {videoId} - videoId
 * @returns {Object} - {videoId, message}
 */
videoController.get("/transcript/:videoId", async (req, res) => {
    let { videoId } = req.params;
    let audio = await redisClient.hget(`video-${videoId}`, 'audio');
    let dest = await redisClient.hget(`video-${videoId}`, 'dest');
    createTranscript(`${dest}/${audio}`).then(async (response) => {
        let textArr = (response.text).replace(/\. /g, '.\n');
        let txtFile = path.resolve("public", dest, `${videoId}.txt`);
        fs.writeFileSync(txtFile, textArr, { encoding: "utf8", flag: "w" });
        return res.json({
            videoId: videoId,
            message: "Video transcription completed"
        }).end();
    }).catch((err) => {
        return res.status(400).json(err).end();
    });

});


/**
 * /embedding - create the embeddings for the video transcript.
 * @param {videoId} - videoId
 * @returns {Object} - {videoId, message}
 */
videoController.get("/embedding/:videoId", async (req, res) => {
    let { videoId } = req.params;
    let dest = await redisClient.hget(`video-${videoId}`, 'dest');
    const textStr = await fs.readFileSync(path.resolve("public", dest, `${videoId}.txt`));
    let chunkData = [];
    const textArr = textStr.toString().split('\n');
    try {
        let index = pineconeLibrary.index('video-gpt');
        let records = [];
        let strCounter = 0;
        for (let chunk of textArr) {
            let embedingsResp = await createEmbeddings(chunk.toString());
            for (let idx of embedingsResp?.data) {
                let embCounter = 0;
                records.push({
                    id: `${videoId}-${strCounter}-${embCounter}-${idx.index}`,
                    values: idx.embedding,
                    metadata: {
                        id: videoId,
                        text: chunk
                    }
                });
                embCounter++;
            }
            strCounter++;
        }
        let upStatus = await index.upsert(records);
        return res.json({
            videoId: videoId,
            message: "embedding completed"
        }).end();
    } catch (err) {
        return res.status(400).json({ err }).end();
    };
});



/**
 * /search - create the embeddings for the video transcript.
 * @param {videoId} - videoId
 * @queryString {question} question which you want to ask related to the video?
 * @returns {Object} - {videoId, message}
 */
videoController.get("/search/:videoId", async (req, res) => {
    let { videoId } = req.params;
    let { question } = req.query;

    let questionEmbedding = await createEmbeddings(question);
    let index = pineconeLibrary.index('video-gpt');
    let embedRes = await index.query({
        vector: questionEmbedding?.data?.[0]?.embedding,
        topK: 3,
        includeMetadata: true,
        includeValues: true
    });
    let contextArr = [];
    for (let text of embedRes?.matches) {
        contextArr.push(text?.metadata?.text);
    }
    let context = contextArr.join(". ");
    const completion = await chatCompletion(context, question);
    const answer = completion?.choices?.[0]?.message?.content
    res.json({
        status: 200,
        message: answer
    }).end();
});

module.exports = videoController;