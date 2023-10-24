const routesConfig = require("express").Router();

const videoController = require("../controllers/videoController");


routesConfig.use("/", videoController);

module.exports = routesConfig;