/**
 * Executa a suíte de testes no Node.js, sem navegador.
 *
 * Os arquivos do jogo são scripts "clássicos" (sem módulos) e dependem de
 * compartilhar o mesmo escopo global. Aqui eles são concatenados dentro de
 * uma função e expostos como um objeto de classes para a suíte compartilhada.
 *
 * Uso:
 *   node test/snake.test.js
 *   node --test test/snake.test.js
 */
"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const rootDir = join(__dirname, "..");
const sourceFiles = [
    "config.js",
    "objects/World.js",
    "objects/Snake.js",
    "objects/Food.js",
    "game.js",
];

const sources = sourceFiles.map((file) =>
    readFileSync(join(rootDir, file), "utf8"),
);

const exportedNames = [
    "World",
    "Snake",
    "Food",
    "SnakeGame",
    "GAME_STATE",
    "GAME_CONFIG",
    "DIRECTION",
];

const exposeClasses = `return { ${exportedNames.join(", ")} };`;
const loadGame = new Function(`${sources.join("\n")}\n${exposeClasses}`);

const classes = loadGame();
const runSuite = require("./test.snake.js");

runSuite(classes);
