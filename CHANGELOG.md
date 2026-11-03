# Changelog

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
