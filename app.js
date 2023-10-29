const express = require("express");
const bodyParser = require("body-parser");
const routesConfig = require("./configs/routesConfig");

const app = express();
app.use(express.static('public'));


app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

app.get("/", (req, res, next) => {
    res.json({ "message": "Hello goes here." });
});

app.use(routesConfig);

module.exports = app;