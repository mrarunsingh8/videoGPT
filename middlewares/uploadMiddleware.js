const moment = require('moment/moment');
const multer = require('multer');
let path = require('path');
const uuid = require("uuid");
const fs = require("fs");

let storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Create the directory with the current date if it doesn't exist
        req.dest = moment().format('YYYY-MM-DD');
        const uploadDir = path.resolve('public', req.dest);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const originalname = `${uuid.v4()}${ext}`;
        cb(null, originalname);
    }
});


module.exports = multer({ storage: storage });