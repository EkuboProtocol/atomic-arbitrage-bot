# @ekubo/atomic-arbitrage-bot

Simple bot that regularly checks for the availability of atomic arbitrage using the Ekubo API and executes it.

## Disclaimer

The purpose of this repository is demonstration only. It demonstrates sending a swap transaction to Ekubo and using the
free, public routing API to compute and execute atomic arbitrage opportunities.

It can be improved in a number of **important** ways, including:
- The bot does not account for gas, so it is not always profitable
- Arbitrage _could_ be done in the context of a lock without ever holding the token--this would mean you can arbitrage tokens without ever holding them

# Instructions

- `npm install`
- Copy `.env.local.example` to `.env.local`
- Add the private key of the arbitrage account
- Tune other `.env` parameters to your liking
  - Example parameters are for sepolia
- Run `npm start`