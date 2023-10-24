const express = require("express");
const fs = require("fs");
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);
const Psc = require('pocketsphinx-continuous');
const openAiLibrary = require("./libraries/openAiLibrary");
const routesConfig = require("./configs/routesConfig");

const app = express();
app.use(express.static('public'));

app.get("/", (req, res, next) => {
    res.json({ "message": "Hello goes here." });
});

app.use(routesConfig);

app.get("/transcriptOld", async(req, res, next) => {
    const inputFile = './public/jara-tasvir-se.mp4';
    const outputFile = path.resolve('public/twinkle.mp3');//'./public/twinkle.mp3';

    openAiLibrary.audio.transcriptions.create({ 
        file: fs.createReadStream(inputFile),
        model: 'whisper-1' 
    }).then((response)=>{
        console.log("response", response);
        res.json(response).end();
    }).catch((err)=>{
        console.log(err);
        res.json(err).end();
    });

    


    /* .chat.completions.create({
        model: "gpt-4",
        messages: [],
        temperature: 0,
        max_tokens: 256,
      });
    console.log();
    res.end(); */
    /* ffmpeg(inputFile).output(outputFile).on('end', async function () {
        console.log('conversion ended');
        const pocketsphinx = new Psc({
            setId: '1337',  // A "set id". See explanation below.
            verbose: false // Setting this to true will give you a whole lot of debug output in your console.
          });
        await pocketsphinx.initialize();
        const transcription = await pocketsphinx.stt(outputFile);
        console.log(`Transcription:\n${transcription}`);

        res.json({ message: "converting completed." });
    }).on('error', function (err) {
        console.log('error: ', err);
        res.json({ message: "converting error." });
    }).run(); */


    /* ffmpeg(inputFile).audioCodec("libmp3lame").toFormat("wav").on('end', () => {
        console.log('Audio conversion finished.');
        //transcribeAudio(outputFile);
        res.json({message: "converting completed."});
    }).on('error', (err) => {
        console.error('Error converting audio:', err);
        res.json({message: "converting error."});
    }).save(outputFile); */
});

module.exports = app;