const multer = require('multer');
let path = require('path');
const uuid = require("uuid");

let storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public');
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const originalname = `${uuid.v4()}${ext}`;
        cb(null, originalname);
    }
});


module.exports = multer({storage: storage});