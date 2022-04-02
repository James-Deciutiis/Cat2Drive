const fs = require("fs");
const url = require("url");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const querystring = require("querystring");

const port = 3000;
const server = http.createServer();

const {
  client_id,
  client_secret,
  scope,
  redirect_uris,
  response_type,
} = require("./credentials.json");
const all_sessions = [];

server.on("listening", listen_handler);
server.listen(port);
function listen_handler() {
  console.log(`Now Listening on Port ${port}`);
}

server.on("request", request_handler);
function request_handler(req, res) {
  console.log(`New Request from ${req.socket.remoteAddress} for ${req.url}`);
  if (req.url === "/") {
    const form = fs.createReadStream("html/index.html");
    res.writeHead(200, { "Content-Type": "text/html" });
    form.pipe(res);
  } else if (req.url.startsWith("/create_cat_request")) {
    let user_input = url.parse(req.url, true).query;
    if (user_input === null) {
      not_found(res);
    }

    const { cat_breed } = user_input;
    console.log("Cat breed:", cat_breed);
    const state = crypto.randomBytes(20).toString("hex");
    all_sessions.push({ cat_breed, state });
    //get_cat_picture_data(res, cat_breed)
    redirect_to_drive(state, res);
  } else if (req.url.startsWith("/receive_code1")) {
    fs.createReadStream("html/redirect.html").pipe(res);
  } else if (req.url.startsWith("/receive_code2")) {
    const { code, state } = url.parse(req.url, true).query;
    console.log("Code:", code);
    console.log("State:", state);
    let session = all_sessions.find((session) => session.state === state);
    console.log("Session", session);
    if (code === undefined || state === undefined || session === undefined) {
      not_found(res);
      return;
    }
    const { cat_breed } = session;
    console.log("Cat Breed:", cat_breed);
    send_access_token_request(code, cat_breed, res, state);
  } else {
    not_found(res);
  }
}

function not_found(res) {
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end("<h1>404 Non Found</h1>");
}

function redirect_to_drive(state, res) {
  const auth_endpoint = "https://accounts.google.com/o/oauth2/v2/auth";
  const redirect_uri = redirect_uris[0];
  let uri = querystring.stringify({
    scope,
    response_type,
    client_id,
    redirect_uri,
    state,
  });
  res.writeHead(302, { Location: `${auth_endpoint}?${uri}` }).end();
}

function send_access_token_request(code, user_input, state, res) {
  const token_endpoint = "https://oauth2.googleapis.com/token";
  const redirect_uri = redirect_uris[0];
  const grant_type = "authorization_code";
  const post_data = querystring.stringify({
    client_id,
    client_secret,
    code,
    grant_type,
    redirect_uri,
  });
  let options = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  https
    .request(token_endpoint, options, (token_stream) =>
      process_stream(token_stream, receive_access_token, user_input, res)
    )
    .end(post_data);
}

function process_stream(stream, callback, ...args) {
  let body = "";
  stream.on("data", (chunk) => (body += chunk));
  stream.on("end", () => callback(body, ...args));
}

function receive_access_token(body, user_input, res) {
  const { access_token } = JSON.parse(body);
  console.log(body);
  get_cat_picture_data(user_input, access_token, res);
}

function get_cat_picture_data(cat_breed, access_token, res) {
  const cat_endpoint = `https://api.thecatapi.com/v1/images/search?breed_ids=${cat_breed}`;
  const downloaded_cat = { count: 0 };
  https.request(cat_endpoint, { method: "GET" }, process_stream).end();
  function process_stream(cat_stream) {
    let cat_data = "";
    cat_stream.on("data", (chunk) => (cat_data += chunk));
    cat_stream.on("end", () =>
      download_cat_image(cat_data, downloaded_cat, access_token)
    );
  }
}

function download_cat_image(cat_data, downloaded_cat, access_token) {
  let cat = JSON.parse(cat_data);
  let url = cat[0].url;
  console.log(url);
  let url_token = url.split("/");
  let filename = url_token[url_token.length - 1];
  let file_type = filename.split(".");
  file_type = file_type[file_type.length - 1];
  const img_path = `cat-image/${filename}`;

  fs.readFile(img_path, function handle_cache(err, data) {
    if (err) {
      console.log("not in cache");
      const image_request = https.get(url);
      image_request.on("response", function receive_image_data(image_stream) {
        const stored_image = fs.createWriteStream(img_path, { encoding: null });
        image_stream.pipe(stored_image);
        stored_image.on("finish", function () {
          downloaded_cat.count++;
          if (downloaded_cat.count > 0) {
            console.log(`Generated Cat Image: ${filename}`);
            upload_new_image(filename, file_type, img_path, access_token);
          }
        });
      });
    } else {
      console.log("In cache");
      upload_image(filename, file_type, data, access_token);
    }
  });
}

function upload_new_image(filename, file_type, img_path, access_token) {
  const upload_endpoint = "https://www.googleapis.com/upload/drive/v3/files";
  const mime_type = `image/${file_type}`;
  const file = fs.readFile(img_path, function send_request(err, data) {
    if (err) {
      throw err;
    }
    const options = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Length": `${data.length}`,
        "Content-Type": `${mime_type}`,
      },
      body: JSON.stringify({
        data,
        mimeType: "application/vnd.google-apps.file",
        name: "cat",
      }),
    };
    https
      .request(upload_endpoint, options, (res, err) => {
        if (err) {
          console.log(err);
        } else {
          console.log("success", res.statusCode);
        }
      })
      .end(data);
  });
}

function upload_image(filename, file_type, data, access_token) {
  const upload_endpoint = "https://www.googleapis.com/upload/drive/v3/files";
  const mime_type = `image/${file_type}`;
  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Length": `${data.length}`,
      "Content-Type": `${mime_type}`,
    },
    body: JSON.stringify({
      data,
      mimeType: "application/vnd.google-apps.file",
      name: "cat",
    }),
  };
  https
    .request(upload_endpoint, options, (res, err) => {
      if (err) {
        console.log(err);
      } else {
        console.log("success", res.statusCode);
      }
    })
    .end(data);
}
