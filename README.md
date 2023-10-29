
# VideoGPT capston project

VideoGPT : Interactive Video Analysis System

## Background & Problem

The digital age has seen an exponential rise in the consumption of 
video content. Platforms like YouTube have become the go-to 
source for educational, entertainment, and informational content. 
However, the process of extracting specific information from these 
videos remains a significant challenge. Existing tools and 
technologies are either inefficient or incapable of allowing users to 
interact with video content in a meaningful and efficient manner.
The primary problem this project aims to address is the 
development of a backend system that enables users to load, 
query, and interact with video content, particularly from platforms 
like YouTube or videos hosted on other platforms.
The system should allow users to provide a video URL, load the 
video, and then ask questions, analyze, and parse through the 
video content.

## Objectives


## Tech Stack

**Server:** Node, Express.

**Database:** Redis, VectorDB(PineCone).

**Packages**: 
  [Express](https://www.npmjs.com/package/express),
  [ioredis](https://www.npmjs.com/package/ioredis),
  [moment](https://www.npmjs.com/package/moment),
  [multer](https://www.npmjs.com/package/multer),
  [openai](https://www.npmjs.com/package/openai),
  [uuid](https://www.npmjs.com/package/uuid),
  [ytdl-core](https://www.npmjs.com/package/ytdl-core),
  [fluent-ffmpeg](https://www.npmjs.com/package/fluent-ffmpeg),
  [@pinecone-database/pinecone](https://www.npmjs.com/package/@pinecone-database/pinecone),
  [@ffmpeg-installer/ffmpeg](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg),


## Author
- [@arun](https://github.com/mrarunsingh8)

## How to run

Clone the project

```bash
  git clone https://github.com/mrarunsingh8/videoGPT
```

Go to the project directory

```bash
  cd videoGPT
```

Install dependencies

```bash
  npm install
```

Start the server for development mode

```bash
  npm run dev
```

It will start a server for development use with url http://localhost:3000/.

### Start

Install dependencies with:

```
npm install
```

and then start with:

```
npm run start
```
### start with docker
```
docker-compose up --build
```

## API Reference

##### Upload a video

```http
   POST /upload
```

| Body | Type     | Description                       |
| :-------- | :------- | :-------------------------------- |
| `file`      | `multipart` | **Required**.|

##### Share a YouTube video URL

```http
   POST /ytdl
```

| Body | Type     | Description                       |
| :-------- | :------- | :-------------------------------- |
| `url`      | `string` | **Required**.|


##### Convert mp4 to mp3

```http
  GET /convert/:videoId
```
| Parameter | Type     | Description                       |
| :-------- | :------- | :-------------------------------- |
| `videoId`      | `string` |  **Required**.|


##### Get the transcript for the video file using recently converted mp3 file
```http
  GET /transcript/:videoId
```
| Parameter | Type     | Description                       |
| :-------- | :------- | :-------------------------------- |
| `videoId`      | `string` |  **Required**.|


##### Get the embedding for the video file and save this into vector DB.
```http
  GET /embedding/:videoId
```
| Parameter | Type     | Description                       |
| :-------- | :------- | :-------------------------------- |
| `videoId`      | `string` |  **Required**.|



##### Ask the question related to the video.
```http
  GET /search/:videoId?question=xyz
```
| Parameter | Type     | Description                       |
| :-------- | :------- | :-------------------------------- |
| `videoId`      | `string` |  **Required**.|

| Query String | Type     | Description                       |
| :-------- | :------- | :-------------------------------- |
| `question`      | `string` |  **Required**.|


