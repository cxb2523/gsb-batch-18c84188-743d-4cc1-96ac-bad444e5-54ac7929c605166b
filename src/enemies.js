initEnemies = function () {

    addEnemies();
    var screen = $('screen');
    for (var i = 0; i < mapEnemies.length; i++) {
        var enemy = mapEnemies[i];
        var type = enemyTypes[enemy.type];
        var img = document.createElement('img');
        img.src = type.img;
        img.style.display = "none";
        img.style.position = "absolute";

        enemy.state = 0;
        enemy.rot = 0;
        enemy.dir = 0;
        enemy.speed = 0;
        enemy.moveSpeed = type.moveSpeed;
        enemy.rotSpeed = type.rotSpeed;
        enemy.numOfStates = type.numOfStates;
        enemy.prevStyle = {
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            clip: '',
            display: 'none',
            zIndex: 0
        };
        enemy.img = img;
        // ranks continue after the sprite ranks so every object in
        // the scene has a unique, frame-stable stacking tie-breaker
        enemy.rank = sprites.length + i + 1;
        enemies.push(enemy);
        screen.appendChild(img);
    }
}

//----------------------------------------------------------

var enemies = [];
var mapEnemies = [];

//----------------------------------------------------------

var enemyTypes = [
    {
        img: 'src/assets/rat.png',
        moveSpeed: 0.05,
        rotSpeed: 3,
        numOfStates: 9
    }
];

//----------------------------------------------------------

addEnemies = function () {

    var enemy = {
        type: 0,
        x: 8.5,
        y: 27.5
    }
    mapEnemies.push(enemy);
}

//----------------------------------------------------------

renderEnemies = function () {
    for (var i = 0; i < enemies.length; i++) {
        var enemy = enemies[i];
        var img = enemy.img;
        var prevStyle = enemy.prevStyle;

        // project once and let the wall depth buffer decide whether
        // the enemy is hidden behind a wall, exactly like the sprites
        var projection = projectObject(enemy.x, enemy.y);
        var inRange = projection !== null && projection.distance < 10;
        // visibility is decided by the wall depth buffer, so an
        // enemy behind a wall stays hidden just like a sprite
        var visible = inRange && isObjectVisible(projection);

        if (!visible) {
            if ('none' != prevStyle.display) {
                img.style.display = 'none';
                prevStyle.display = 'none';
            }
            // AI only ticks within the old 10-unit range;
            // the chase/idle rules themselves are unchanged
            if (inRange) {
                enemyAI(enemy);
            }
            continue;
        }

        var size = projection.size;
        var x = Math.tan(projection.angle) * viewDist;
        var zIndex = depthZIndex(projection.depth, enemy.rank);

        if (size != prevStyle.height) {
            img.style.height = size + 'px';
            prevStyle.height = size;
        }
        // times the total number of states
        if ((size * enemy.numOfStates) != prevStyle.width) {
            img.style.width = (size * enemy.numOfStates) + 'px';
            prevStyle.width = (size * enemy.numOfStates);
        }
        if (((screenHeight - size) / 2) != prevStyle.top) {
            img.style.top = ((screenHeight - size) / 2) + 'px';
            prevStyle.top = ((screenHeight - size) / 2);
        }
        if ((screenWidth / 2 + x - size / 2 - size * enemy.state) != prevStyle.left) {
            img.style.left = (screenWidth / 2 + x - size / 2 - size * enemy.state) + 'px';
            prevStyle.left = (screenWidth / 2 + x - size / 2 - size * enemy.state);
        }
        if (("brightness(" + (100 - 15 * projection.distance) + "%)") != prevStyle.filter) {
            img.style.filter = ("brightness(" + (100 - 15 * projection.distance) + "%)");
            prevStyle.filter = ("brightness(" + (100 - 15 * projection.distance) + "%)");
        }
        if (zIndex != prevStyle.zIndex) {
            img.style.zIndex = zIndex;
            prevStyle.zIndex = zIndex;
        }
        if ('block' != prevStyle.display) {
            img.style.display = 'block';
            prevStyle.display = 'block';
        }
        if (('rect(0, ' + (size * (enemy.state + 1)) + ', ' + size + ', ' + (size * (enemy.state)) + ')') != prevStyle.clip) {
            img.style.clip = ('rect(0, ' + (size * (enemy.state + 1)) + ', ' + size + ', ' + (size * (enemy.state)) + ')');
            prevStyle.clip = ('rect(0, ' + (size * (enemy.state + 1)) + ', ' + size + ', ' + (size * (enemy.state)) + ')');
        }
        enemyAI(enemy);
    }
}

//----------------------------------------------------------

enemyAI = function (enemy) {

    var dx = player.x - enemy.x;
    var dy = player.y - enemy.y;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if ((distance > 2) && (distance < 8)) {
        var angle = Math.atan2(dy, dx);
        enemy.rotDeg = angle * 180 / Math.PI;
        enemy.rot = angle;
        enemy.speed = 1;
        var walkCycleTime = 1000;
        var numWalkSprites = 7;
        enemy.state = Math.floor((new Date() % walkCycleTime) / (walkCycleTime / numWalkSprites)) + 1;
    } else {
        enemy.state = 0;
        enemy.speed = 0;
    }
    enemyMove(enemy);
}

//----------------------------------------------------------

enemyMove = function (enemy) {

    var moveStep = enemy.speed * enemy.moveSpeed;
    var newX = enemy.x + Math.cos(enemy.rot) * moveStep;
    var newY = enemy.y + Math.sin(enemy.rot) * moveStep;

    // vars take player's collision checker
    var pos = checkCollision(enemy.x, enemy.y, newX, newY, 0.35);
    enemy.x = pos.x;
    enemy.y = pos.y;
}

//----------------------------------------------------------