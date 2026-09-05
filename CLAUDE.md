# Polymarket HFT — Development Rules (Karpathy Guidelines)

## 1. Think Before Coding
State assumptions explicitly. When ambiguity exists, present options. Never run with silent assumptions.

## 2. Simplicity First
Deliver minimum code that solves the problem. No speculative features. No unrequested abstractions.
Three identical patterns are better than one premature abstraction.

## 3. Surgical Changes
Touch only what the task requires. Match existing style. Leave unrelated code untouched.

## 4. Goal-Driven Execution
Every change must have a verifiable success criterion. Loop until criteria are met.

## Architecture Rules
- Every pipeline stage has one input type and one output type
- All state lives in Redis (volatile) or PostgreSQL (durable) — never only in process memory
- No order is submitted without passing all 6 risk checks
- Kill switch must be testable independently of all other components
- Bankroll is always loaded from PostgreSQL on startup, never from config defaults
- WebSocket reconnect must request snapshot before processing any deltas
- ClobClient is a singleton — credentials derived once at startup
