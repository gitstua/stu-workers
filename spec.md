This is the specification for the endpoints in this worker

## /fractal

This endpoint generates a fractal image based on the parameters provided.

Parameters:
- `width`: The width of the image to generate.
- `height`: The height of the image to generate.
- `maxIter`: The maximum number of iterations to use in the fractal calculation.
- `seed`: The seed to use for the fractal calculation.
- `fractalType`: The type of fractal to generate.

Returns:
- A JSON object containing the following properties:
  - `width`: The width of the image.
  - `height`: The height of the image.
  - `data`: A base64 encoded string of the image data.

## /ndjson-to-json

This endpoint converts an NDJSON stream to a JSON object.

Parameters:
- `ndjson`: The NDJSON stream to convert.

Returns:
- A JSON object containing the converted NDJSON stream.

## /xml-to-json

This endpoint converts an XML stream to a JSON object.

Parameters:
- `xml`: The XML stream to convert.

Returns:
- A JSON object containing the converted XML stream.

## /poll
A new endpoint which helps people vote on what is for dinner

1. new endpoint to add a new poll `/poll/new`
2. an endpoint which allows you to vote (optionally pass a specific id) `/poll/vote`

Each poll has
- id: guid (randomly generated)
- open (date and time the will open)
- close (date and time the poll will closed)
- options [{"name":"option1", "url":"https://example.com/option1", "votes":0}, {"name":"option2" , "url":"https://example.com/option2", "votes":0}, {"name":"option3", "url":"https://example.com/option3", "votes":0}]

store the data for the poll in Cloudflare KV against the id




