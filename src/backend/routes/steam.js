import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import OpenAI from "openai";
//setup
dotenv.config(); //load env variables
const router = express.Router(); //router instance
const STEAM_API_KEY = process.env.STEAM_API_KEY; //api key
// OpenAI client setup
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
// base url for steam api to build off of
const BASE_URL = 'https://api.steampowered.com';
// function to extract steam id from the url provided by the user at home
function extractSteamId(steamUrl) {
    // different patterns to check for a steam url
    const patterns = [
        /steamcommunity\.com\/profiles\/(\d+)/,
        /steamcommunity\.com\/id\/([^\/]+)/
    ];
    //if the url matches one of our expected url patterns return it, if none are true return null
    for (const pattern of patterns) {
        const match = steamUrl.match(pattern);
        if (match) {
            return match[1];
        }
    }
    return null;
}

// route to get user profile info
router.get('/user/:encodedUrl', async (req, res) => {
    try {
        //get decoded url parameter
        const steamUrl = decodeURIComponent(req.params.encodedUrl);
        console.log('received steam url:', steamUrl);
        //extract the id from the url with function from earlier
        let steamId = extractSteamId(steamUrl);
        console.log('extracted steam id:', steamId);
        //if no steam id then return error
        if (!steamId) {
            console.log('invalid url format');
            return res.status(400).json({ error: 'invalid steam url format' });
        }
        // if its a custom url we use api to turn it back into a usual steam url
        if (isNaN(steamId)) {
            console.log('fixing custom url:', steamId);
            //using api, to get the id of the custom url
            const resolveResponse = await axios.get(
                `${BASE_URL}/ISteamUser/ResolveVanityURL/v0001/`, {
                headers: {
                    'Accept': 'application/json'
                }, params: {
                    key: STEAM_API_KEY,
                    vanityurl: steamId
                }
            }
            );
            console.log('resolve response:', resolveResponse.data);
            //if the resolve isnt a success, then 404 + error
            if (resolveResponse.data.response.success !== 1) {
                return res.status(404).json({ error: 'that steam profile isnt found' });
            }
            //set steam id to the steam id we just got from the functions above
            steamId = resolveResponse.data.response.steamid;
            console.log('Resolved Steam ID:', steamId);
        }
        // getting user summary 
        console.log('fetching the user summary:', steamId);
        const userResponse = await axios.get(
            `${BASE_URL}/ISteamUser/GetPlayerSummaries/v0002/`, {
            headers: {
                'Accept': 'application/json'
            }, params: {
                key: STEAM_API_KEY,
                steamids: steamId
            }
        }
        );
        console.log('user response:', userResponse.data);
        //get the first of the user data that is present
        const userData = userResponse.data.response.players[0];
        //error handle if no user data
        if (!userData) {
            return res.status(404).json({ error: 'steam profile not found' });
        }
        // check if profile is public, if not then return error
        if (userData.communityvisibilitystate !== 3) {
            return res.status(403).json({
                error: 'Steam profile is private. Please make your profile public to use this service.'
            });
        }
        // preparing object to whole api response data
        const responseData = {
            steamId: userData.steamid,
            personaName: userData.personaname,
            avatarUrl: userData.avatarfull || userData.avatarmedium || userData.avatar,
            profileUrl: userData.profileurl,
            countryCode: userData.loccountrycode,
            timeCreated: userData.timecreated
        };
        // sending response back to the client
        console.log('sending res:', responseData);
        res.json(responseData);

    } catch (error) {
        //error handling
        console.error('error fetching data:', error.message);
        if (error.response) {
            console.error('error response data:', error.response.data);
        }
        res.status(500).json({ error: 'failed to fetch the steam data' });
    }
});

// route to get the users owned games
router.get('/games/:steamId', async (req, res) => {
    try {
        //get steam id from parameters
        const { steamId } = req.params;
        console.log('fetching games from the steam id:', steamId);
        // send api request for the users owned games
        const gamesResponse = await axios.get(
            `${BASE_URL}/IPlayerService/GetOwnedGames/v0001/`, {
            headers: {
                'Accept': 'application/json'
            }, params: {
                key: STEAM_API_KEY,
                steamid: steamId,
                include_appinfo: true,
                include_played_free_games: true
            }
        }
        );
        // getting the data from the response
        console.log('response from requesting game data:', gamesResponse.data);
        const gamesData = gamesResponse.data.response;
        //error handling
        if (!gamesData.games || gamesData.games.length === 0) {
            console.log('account private or no games found.');
            return res.json({ games: [], gameCount: 0 });
        }
        console.log(`found ${gamesData.games.length} games`);

        // sorting games based on playtime
        const sortedGames = gamesData.games.sort((a, b) =>
            (b.playtime_forever || 0) - (a.playtime_forever || 0)
        );
        // returning the sorted games and game count
        res.json({
            games: sortedGames,
            gameCount: gamesData.game_count
        });
    } catch (error) {
        console.error('error fetching the data from the games:', error.message);
        if (error.response) {
            console.error('api error fetching games:', error.response.data);
        }
        res.status(500).json({ error: 'failed to fetch the game data' });
    }
});

// using the response from steam api to feed game information to GPT for custom gpt recommendations
router.get('/askingForRecs/:steamId', async (req, res) => {
    console.log('gpt route hit');
    try {
        console.log('starting gpt request');
        //regular steam request for owned games
        const { steamId } = req.params;

        if (!steamId) {
            return res.status(400).json({ error: 'Steam ID is required' });
        }

        const gamesResponse = await axios.get(
            `${BASE_URL}/IPlayerService/GetOwnedGames/v0001/`, {
            headers: {
                'Accept': 'application/json'
            }, params: {
                key: STEAM_API_KEY,
                steamid: steamId,
                include_appinfo: true,
                include_played_free_games: true
            }
        }
        );

        // saving steam data from api
        const gamesData = gamesResponse.data.response;

        if (!gamesData || !gamesData.games || gamesData.games.length === 0) {
            return res.status(404).json({
                error: 'No games found for this Steam profile or profile is private'
            });
        }

        const userGames = gamesData.games;
        console.log(`Found ${userGames.length} games for user`);

        // limiting data for less gpt token usage and better performance
        const topGames = userGames
            .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
            .slice(0, 20)
            .map(game => ({
                name: game.name,
                playtime_forever: game.playtime_forever || 0,
                appid: game.appid
            }));

        console.log('sending request to openai');

        // creating open ai response using games data for prompt
        const openaiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are a helpful gaming assistant that provides game recommendations based on a user's Steam gaming history. Provide exactly 3 game recommendations with brief explanations telling them why they would like the game and comparing its similarities to games the user has played."
                },
                {
                    role: "user",
                    content: `Based on my Steam gaming history below, please recommend me 3 games I should play next. Focus on games similar to my most played titles.

My top games and hours played:
${topGames.map(game => `- ${game.name}: ${Math.floor(game.playtime_forever / 60)} hours`).join('\n')}

Please format your response as:
1. [Game Name] - [Brief reason why I'd like it]
2. [Game Name] - [Brief reason why I'd like it]  
3. [Game Name] - [Brief reason why I'd like it]`
                }
            ],
            max_tokens: 500,
            temperature: 0.7
        });

        //logging the openai response for debugging
        const recommendation = openaiResponse.choices[0].message.content;

        //saving response and returning it to client
        res.json({
            recommendation: recommendation,
            gamesAnalyzed: topGames.length
        });

    } catch (error) {
        console.error('GPT error details:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status,
            stack: error.stack
        });

        // Handle specific OpenAI errors
        if (error.response?.status === 429) {
            return res.status(429).json({
                error: 'Rate limit exceeded. Please try again in a few minutes.'
            });
        }

        if (error.response?.status === 401) {
            return res.status(500).json({
                error: 'API authentication failed. Please contact support.'
            });
        }

        if (error.response?.status >= 500) {
            return res.status(503).json({
                error: 'OpenAI service is temporarily unavailable. Please try again later.'
            });
        }

        // Check if it's a Steam API error
        if (error.response?.data?.response) {
            return res.status(500).json({
                error: 'Failed to fetch Steam game data'
            });
        }

        res.status(500).json({
            error: 'Failed to generate game recommendations. Please try again.'
        });
    }
});


// Retired route for game recommendations
// This route was used to get game recommendations based on the user's Steam ID, without using GPT.


// route to get 5 random / barely played games
// router.get('/recommendations/:steamId', async (req, res) => {
//     try {
//         //getting data from the params
//         const { steamId } = req.params;
//         const { limit = 5 } = req.query;
//         //our game request
//         const gamesResponse = await axios.get(
//             `${BASE_URL}/IPlayerService/GetOwnedGames/v0001/`, {
//             headers: {
//                 'Accept': 'application/json'
//             }, params: {
//                 key: STEAM_API_KEY,
//                 steamid: steamId,
//                 include_appinfo: true,
//                 include_played_free_games: true
//             }
//         }
//         );
//         //setting this data as our res
//         const gamesData = gamesResponse.data.response;
//         //if no games or unplayed then return those
//         if (!gamesData.games || gamesData.games.length === 0) {
//             return res.json({ recommendations: [] });
//         }

//         // allowing games that are unplayed or barely played
//         const underplayedGames = gamesData.games.filter(game =>
//             (game.playtime_forever || 0) < 120 // less than 2 hours (minutes)
//         );

//         // shuffling / picking unplayed games that we find above
//         const shuffled = underplayedGames.sort(() => 0.5 - Math.random());
//         const recommendations = shuffled.slice(0, parseInt(limit));

//         res.json({ recommendations });
//         //error handling
//     } catch (error) {
//         console.error('error fetching recommendations:', error.message);
//         res.status(500).json({ error: 'failed to fetch game recommendations' });
//     }
// });

export default router;


