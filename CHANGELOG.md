# Changelog

## [0.5.0](https://github.com/hrustalq/watchdog/compare/v0.4.0...v0.5.0) (2026-11-07)


### ⚠ BREAKING CHANGES

* **core:** web and worker no longer start with a blank or missing WATCHDOG_ENCRYPTION_KEY. Set it in .env before upgrading. Generate one with: openssl rand -base64 32

### Features

* **core:** add the Action to the rule model and its YAML ([#214](https://github.com/hrustalq/watchdog/issues/214)) ([5a7a192](https://github.com/hrustalq/watchdog/commit/5a7a192503082ab323780a5b0f7ecbec1b7eda94))
* **core:** add the Agent interface on the Vercel AI SDK, metering every attempt ([#121](https://github.com/hrustalq/watchdog/issues/121)) ([4b46e6d](https://github.com/hrustalq/watchdog/commit/4b46e6dfd85209dab679cc6a75a5d579811a4cc0))
* **core:** add the canonical rule model and Condition evaluation ([#102](https://github.com/hrustalq/watchdog/issues/102)) ([3c9c6c2](https://github.com/hrustalq/watchdog/commit/3c9c6c2c47dcacecc2bb89fb5925b22556b84fb2))
* **core:** call webhook destinations with a signed payload ([#233](https://github.com/hrustalq/watchdog/issues/233)) ([b6065a0](https://github.com/hrustalq/watchdog/commit/b6065a0c5dd5a510db24d814ec4362767815d880))
* **core:** capture feed entries as deduplicated items with a backfill and a log ([#63](https://github.com/hrustalq/watchdog/issues/63)) ([0650582](https://github.com/hrustalq/watchdog/commit/06505828e1ab6c9673268540b800329344721c85))
* **core:** encrypt secrets at rest with a versioned AES-256-GCM key ([#106](https://github.com/hrustalq/watchdog/issues/106)) ([7e09cc3](https://github.com/hrustalq/watchdog/commit/7e09cc3462969b10503c8da784cd54d9c740fd8d))
* **core:** fetch and parse rss and atom feeds into the item envelope ([#59](https://github.com/hrustalq/watchdog/issues/59)) ([4fb16ad](https://github.com/hrustalq/watchdog/commit/4fb16ad251739c46e885f26ff0ef72b0d3a8eda2))
* **core:** hold alerts in quiet hours and group bursts into one message ([#224](https://github.com/hrustalq/watchdog/issues/224)) ([9a6fbe5](https://github.com/hrustalq/watchdog/commit/9a6fbe52456cf90e35c5a77f7ee1446c4ced2edf))
* **core:** rate items and run agent-backed extractor rules in one call ([#142](https://github.com/hrustalq/watchdog/issues/142)) ([684bb5f](https://github.com/hrustalq/watchdog/commit/684bb5f848b568fe26b98dba40c20240e48619f3))
* **core:** route every outbound request through one egress guard ([#57](https://github.com/hrustalq/watchdog/issues/57)) ([bf499ac](https://github.com/hrustalq/watchdog/commit/bf499aceec709ed8db00d99d6c3a3d778140bf22))
* **core:** run agent-backed classifiers in one call per item ([#138](https://github.com/hrustalq/watchdog/issues/138)) ([6dbc7fe](https://github.com/hrustalq/watchdog/commit/6dbc7fe09c655dde78260fc4543c87b9e76784f6))
* **core:** run deterministic Extractor Rules on Items that meet their Condition ([#109](https://github.com/hrustalq/watchdog/issues/109)) ([f966d5d](https://github.com/hrustalq/watchdog/commit/f966d5dec4fb4c99b81cbd87a95d36f3052f80f8))
* **core:** run the act stage when an item finishes processing ([#215](https://github.com/hrustalq/watchdog/issues/215)) ([dca8a01](https://github.com/hrustalq/watchdog/commit/dca8a01a94253c7e16fe7947de085374f0950b92))
* **core:** send alert emails through the mailer with the hosted daily cap ([#225](https://github.com/hrustalq/watchdog/issues/225)) ([c65bff3](https://github.com/hrustalq/watchdog/commit/c65bff382748d56aa61dbbfbef4015b77b2afb33))
* **core:** send telegram alerts through the bot within its flood limits ([#219](https://github.com/hrustalq/watchdog/issues/219)) ([8cf1d19](https://github.com/hrustalq/watchdog/commit/8cf1d1924c28a161a8c792ad7aabfeccd1265ef1))
* **core:** settle whether Actions fire on unrated Items ([#209](https://github.com/hrustalq/watchdog/issues/209)) ([6c1a4ce](https://github.com/hrustalq/watchdog/commit/6c1a4ce94a093f5c8d3c756f6a87ad37e892c080))
* **db:** add source, item and log tables to the database schema ([#54](https://github.com/hrustalq/watchdog/issues/54)) ([3a57d5a](https://github.com/hrustalq/watchdog/commit/3a57d5a619c454987bc921f13cac6159b326a228))
* **db:** add the Destination, Action and Delivery tables and Workspace alert settings ([#211](https://github.com/hrustalq/watchdog/issues/211)) ([89b4e27](https://github.com/hrustalq/watchdog/commit/89b4e27751f6d859ec3f8e4458b98f6ab3394bc9))
* **db:** add the rule, Rating, Correction, Profile, model and metering tables ([#104](https://github.com/hrustalq/watchdog/issues/104)) ([87c4458](https://github.com/hrustalq/watchdog/commit/87c4458e0eaec46bf75d6d9dccaa2f0a2504f14f))
* **web:** add actions to the rules screen ([#234](https://github.com/hrustalq/watchdog/issues/234)) ([130241b](https://github.com/hrustalq/watchdog/commit/130241b7500c9cdc17390deb5ef9a54d361487e0))
* **web:** add the Destinations screen ([#231](https://github.com/hrustalq/watchdog/issues/231)) ([dc5e0c0](https://github.com/hrustalq/watchdog/commit/dc5e0c01c9dd67851090f5afe4167775a09a4f87))
* **web:** add the Model screen for bringing your own model ([#123](https://github.com/hrustalq/watchdog/issues/123)) ([f80e87f](https://github.com/hrustalq/watchdog/commit/f80e87f07b691d4af8178eea4d518cfb54e000bf))
* **web:** add the Profile screen with the output language ([#131](https://github.com/hrustalq/watchdog/issues/131)) ([ce3eb29](https://github.com/hrustalq/watchdog/commit/ce3eb292940fb182b674c05b74611fecdefca0bc))
* **web:** add the rules screen with form and yaml editing ([#113](https://github.com/hrustalq/watchdog/issues/113)) ([8ce2350](https://github.com/hrustalq/watchdog/commit/8ce235017f5f1e97c07bef32081fab0fbd509d66))
* **web:** add the Top view as the Feed's default order ([#155](https://github.com/hrustalq/watchdog/issues/155)) ([74c550d](https://github.com/hrustalq/watchdog/commit/74c550de14001cd0474c0e63b63acc402e0f114c))
* **web:** add the Usage screen with monthly Agent usage per model ([#163](https://github.com/hrustalq/watchdog/issues/163)) ([778a8cd](https://github.com/hrustalq/watchdog/commit/778a8cd6bb39c567b439f5563d3df81491c742ff))
* **web:** add, list and remove rss sources in the web app ([#68](https://github.com/hrustalq/watchdog/issues/68)) ([1780ab1](https://github.com/hrustalq/watchdog/commit/1780ab10971b44446d19cab9894f0757471ead17))
* **web:** keep the workspace header usable at phone width ([#176](https://github.com/hrustalq/watchdog/issues/176)) ([93e0015](https://github.com/hrustalq/watchdog/commit/93e0015a5d1d308795c67f55b2f8c744d1182120))
* **web:** let the user correct an item's rating and categories ([#158](https://github.com/hrustalq/watchdog/issues/158)) ([d322e11](https://github.com/hrustalq/watchdog/commit/d322e11eaa1113a9934c2d0003424bdde0718608))
* **web:** run an extractor rule by hand on one item ([#145](https://github.com/hrustalq/watchdog/issues/145)) ([1e10406](https://github.com/hrustalq/watchdog/commit/1e10406586bdfca504b92ffe9365d6f8045efee8))
* **web:** show an unreadable API key on the Model screen without a test ([#178](https://github.com/hrustalq/watchdog/issues/178)) ([defff7a](https://github.com/hrustalq/watchdog/commit/defff7a56e6a5fbbb091ea13df25d6dd205509b1))
* **web:** show categories, rating, summary and log trace in the feed and item ([#149](https://github.com/hrustalq/watchdog/issues/149)) ([cf88995](https://github.com/hrustalq/watchdog/commit/cf88995b665796af7b0620793913e686b5699e85))
* **web:** show items in the feed's latest view with each item's log ([#70](https://github.com/hrustalq/watchdog/issues/70)) ([a8821cc](https://github.com/hrustalq/watchdog/commit/a8821cc4073f0cc829fab5359616dbff388755be))
* **web:** show what each rating level means ([#181](https://github.com/hrustalq/watchdog/issues/181)) ([b11503a](https://github.com/hrustalq/watchdog/commit/b11503a8899ef1ddf8aec7dd3144715929dc72b1))
* **worker:** deliver alerts through a queue that retries for up to 24 hours ([#217](https://github.com/hrustalq/watchdog/issues/217)) ([af85bbb](https://github.com/hrustalq/watchdog/commit/af85bbbdd68d124d66bba1f27ed5b823948b9b6a))
* **worker:** poll sources on their schedule with a one-minute tick ([#67](https://github.com/hrustalq/watchdog/issues/67)) ([6e0ca2e](https://github.com/hrustalq/watchdog/commit/6e0ca2e48dedff95f18859f3c2487e8dfaa2bee8))
* **worker:** run captured Items through a job with deterministic Classifiers ([#108](https://github.com/hrustalq/watchdog/issues/108)) ([4ad83a6](https://github.com/hrustalq/watchdog/commit/4ad83a65384eded6ddf255053c86309de5f30e56))


### Bug Fixes

* **core:** fill in a correction's summary when the agent writes it later ([#185](https://github.com/hrustalq/watchdog/issues/185)) ([78518a3](https://github.com/hrustalq/watchdog/commit/78518a3a5e793a908b2d8aec33a75b3a9033f71c))
* **core:** keep paragraph breaks in item bodies ([#77](https://github.com/hrustalq/watchdog/issues/77)) ([59de128](https://github.com/hrustalq/watchdog/commit/59de1285910966605a9f2f06c9e7a6e446295093))
* **db:** close every pooled connection before an integration test stops postgres ([#74](https://github.com/hrustalq/watchdog/issues/74)) ([6c62982](https://github.com/hrustalq/watchdog/commit/6c62982768a9e1ceb9c735f256fe5e431f90ac48))
* **web:** keep destination rows at 32 px on a phone ([#238](https://github.com/hrustalq/watchdog/issues/238)) ([edf2b76](https://github.com/hrustalq/watchdog/commit/edf2b76c9e3c51ca887e20c7a81e91e7c9290b24))
* **web:** keep show older working after the cursor's item is deleted ([#75](https://github.com/hrustalq/watchdog/issues/75)) ([5d32e3f](https://github.com/hrustalq/watchdog/commit/5d32e3f635b5ebc8e17211c92b7ee90ad88d7721))
* **web:** keep the outline border on buttons rendered as links ([#168](https://github.com/hrustalq/watchdog/issues/168)) ([9f99b75](https://github.com/hrustalq/watchdog/commit/9f99b75e496d72fcacdc8ecbab9dd98286c8f218))
* **web:** refuse a feed url the workspace already watches ([#76](https://github.com/hrustalq/watchdog/issues/76)) ([09e002c](https://github.com/hrustalq/watchdog/commit/09e002cc55ceefd4c9ba3517db04c12138062437))

## [0.4.0](https://github.com/hrustalq/watchdog/compare/v0.3.0...v0.4.0) (2026-11-03)


### Features

* **web:** announce sign-in error notices to screen readers when the page loads ([#44](https://github.com/hrustalq/watchdog/issues/44)) ([da511a8](https://github.com/hrustalq/watchdog/commit/da511a8856cc580b4b41978243e1a0a31c462efa))
* **web:** stop clients from choosing their own rate-limit key with x-forwarded-for ([#42](https://github.com/hrustalq/watchdog/issues/42)) ([24a52d4](https://github.com/hrustalq/watchdog/commit/24a52d44f4995a61af5f6de62b2da4d265ec2eb5))

## [0.3.0](https://github.com/hrustalq/watchdog/compare/v0.2.0...v0.3.0) (2026-11-03)


### Features

* **web:** let static files and API calls through the sign-in proxy ([#39](https://github.com/hrustalq/watchdog/issues/39)) ([7b4cd9d](https://github.com/hrustalq/watchdog/commit/7b4cd9d6e19188e50dcb05885ddd6108b7744790))
* **web:** return to the requested page after signing in ([#40](https://github.com/hrustalq/watchdog/issues/40)) ([0efb320](https://github.com/hrustalq/watchdog/commit/0efb320dd7a706e05ec27b3b04289cfc58e875d8))


### Bug Fixes

* **web:** keep magic links working when a mail scanner opens them first ([#37](https://github.com/hrustalq/watchdog/issues/37)) ([739c0cf](https://github.com/hrustalq/watchdog/commit/739c0cf3c20b1f222317702e50ea85da9b5a426a))

## [0.2.0](https://github.com/hrustalq/watchdog/compare/v0.1.0...v0.2.0) (2026-11-03)


### Features

* **core:** load and validate env config with WATCHDOG_MODE and .env.example ([#17](https://github.com/hrustalq/watchdog/issues/17)) ([615b4ae](https://github.com/hrustalq/watchdog/commit/615b4ae99060633fa2a6dbba002baa3bc3282630))
* **db:** set up the drizzle client and migrations in packages/db ([#19](https://github.com/hrustalq/watchdog/issues/19)) ([1a192ea](https://github.com/hrustalq/watchdog/commit/1a192ea7ad7645d7dc0d358ba23a568fb43191c6))
* run web, worker, postgres and obscura with docker compose ([#31](https://github.com/hrustalq/watchdog/issues/31)) ([4ddc531](https://github.com/hrustalq/watchdog/commit/4ddc531b58741d3e4609b4d5c470b1caa05483ab))
* **web:** add a self-hosted first-run admin and a sign-up switch ([#30](https://github.com/hrustalq/watchdog/issues/30)) ([1fefc81](https://github.com/hrustalq/watchdog/commit/1fefc8140bb230409d71de5991759eaf32f9d26c))
* **web:** add optional google and github oauth sign-in ([#26](https://github.com/hrustalq/watchdog/issues/26)) ([35b2fb9](https://github.com/hrustalq/watchdog/commit/35b2fb96b130073579d98f529950a342d565e672))
* **web:** sign in by magic link and create a single-user workspace ([#21](https://github.com/hrustalq/watchdog/issues/21)) ([b4cfc69](https://github.com/hrustalq/watchdog/commit/b4cfc698c14e3635824485cc91aefbf93b9dbf6b))
