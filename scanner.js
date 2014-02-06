var util = require('util'),
    fs = require('fs'),
    async = require('async'),
    jsdom = require('jsdom'),
    redis = require('redis'),
    changeCase = require('change-case');

var jquery = fs.readFileSync('node_modules/jquery/dist/jquery.min.js', 'utf-8');

findHelmets();

function findHelmets() {
    var detailPages = [],
        pageNo = 0,
        pageCount = -1, // don't know this until after the first page is loaded
        done = false;

    async.doUntil(
        fetchPage,
        function() { return done; },
        function(err) {
            if (err) throw err;
            loadHelmets(detailPages);
        }
    );

    function fetchPage(next) {
        function pageLoaded(errors, window) {
            if (util.isError(errors)) throw errors;  // Single error with page fetching, parsing, etc.
            if (errors) return console.error(errors);  // What to do? Errors from page scripts

            var $ = window.$;

            if (pageCount == -1) {
                var found = $('li.pager-current').text().trim().match(/^\d+ of (\d+)$/);
                if (found) pageCount = +found[1];
            }

            $('#search-results td.views-field-title-1>a').each(function() {
                detailPages.push($(this).attr('href'));
            });

            pageNo++;
            done = $('li.pager-next a').length == 0;
            next();
        }

        if (pageCount == -1) {
            console.log('Loading index page', (pageNo + 1));
        } else {
            console.log('Loading index page', (pageNo + 1), 'of', pageCount);
        }

        jsdom.env({
            url: pageUrl(pageNo),
            src: [jquery],
            done: pageLoaded
        });
    }

    function pageUrl(pageNo) {
        return util.format('http://sharp.direct.gov.uk/testhelmetlist?page=%d&sharp-make=All&sharp-model=&sharp-type=All&sharp-rating=1&discontinued=1', pageNo);
    }
}

function loadHelmets(detailPages) {
    var detailCount = 0;

    console.log('About to load', detailPages.length, 'helmets');

    async.mapLimit(detailPages, 5, loadHelmetDetails, function(err, helmets) {
        if (err) throw err;
        console.log('Loaded details of', helmets.length, 'helmets');
        storeHelmets(helmets);
    });

    function loadHelmetDetails(url, next) {
        console.log('Loading detail page', ++detailCount, 'of', detailPages.length);

        jsdom.env({
            url: detailUrl(url),
            src: [jquery],
            done: pageLoaded
        });

        function pageLoaded(errors, window) {
            if (util.isError(errors)) throw errors;  // Single error with page fetching, parsing, etc.
            if (errors) return console.error(errors);  // What to do? Errors from page scripts

            var $ = window.$,
                helmet = {
                    features: [],
                    impact: {}
                };

            $('.helmet-details dt').each(function() {
                var $this = $(this),
                    $dd = $this.next('dd'),
                    key = $this.text();

                var detailFn = mapDetails[key.toLowerCase().trim()];
                if (detailFn) detailFn($, key, $dd, helmet);
            });

            $('.helmet-features .features li').each(function() {
                helmet.features.push(changeCase.paramCase($(this).text().trim()));
            });

            var starsText = $('p.rating img').attr('alt').trim(),
                starsFound = starsText.match(/^(\d+) out of 5$/);
            if (starsFound) {
                helmet.stars = +starsFound[1];
            } else {
                console.warn('Unparsable stars:', starsText);
            }

            $('.impactimages div[class^="impact_"] span').each(function() {
                var impact = $(this).attr('class'),
                    impactFound = impact.match(/^([a-z]+)-(\d)$/);

                if (impactFound) {
                    helmet.impact[impactFound[1]] = +impactFound[2];
                } else {
                    console.warn('Unparsable impact:', impact);
                }
            });

            helmet.imageUrl = $('.helmet-images img').first().attr('src');

            next(null, helmet);
        }
    }

    function detailUrl(fragment) {
        return 'http://sharp.direct.gov.uk' + fragment;
    }
}

function storeHelmets(helmets) {
    var r;

    console.log('Connecting to Redis');

    if (process.env.REDISCLOUD_URL) {
        console.log('(Using RedisCloud URL', process.env.REDISCLOUD_URL, ')');

        var url = require("url").parse(process.env.REDISCLOUD_URL);
        r = redis.createClient(url.port, url.hostname, {
            auth_pass: url.auth.split(':')[1]
        });
    } else {
        r = redis.createClient();
    }

    r.on('error', function(err) {
        console.log(err);
    });

    r.on('ready', function() {
        console.log('Connected to Redis');

        r.set('helmets', JSON.stringify(helmets));
        r.quit();
    });

    r.on('end', function() {
        console.log('Disconnected from Redis');
    });
}

var mapDetails = {
    'make': simpleString,
    'model': simpleString,
    'type': simpleString,
    'weight': weight,
    'sizes': sizes,
    'price from': price,
    'retention system': simpleString,
    'construction materials': ul,
    'other standards': ul,
    'manufacturer\'s website': simpleString
}

function simpleString($, key, $details, helmet) {
    helmet[changeCase.camelCase(key.replace(/[^\w\s]/, '', 'g'))] = $details.text();
}

function weight($, key, $details, helmet) {
    var found = $details.text().trim().match(/^(\d+(?:\.\d+)?)\s*kg$/);
    if (found) {
        helmet.weightKg = +found[1];
    } else {
        console.warn('Unparsable weight:', $details.text());
    }
}

function sizes($, key, $details, helmet) {
    var result = $details.text().trim().toUpperCase().split(/\s+/);
    helmet.sizes = result;
}

function price($, key, $details, helmet) {
    var found = $details.text().trim().match(/^(\d+(?:\.\d+)?)$/);
    if (found) {
        helmet.price = +found[1];
    } else {
        console.warn('Unparsable price:', $details.text());
    }
}

function ul($, key, $details, helmet) {
    helmet[changeCase.camelCase(key)] = $details.find('ul>li').map(function() {
        return $(this).text();
    }).get();
}

