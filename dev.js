require("dotenv").config();
const app = require("./app");

app.listen(3000, ()=>{
    console.log("Server is listen on port 3000");
});

