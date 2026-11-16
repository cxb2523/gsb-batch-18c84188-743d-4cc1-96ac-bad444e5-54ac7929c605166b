initSprites = function () {

    addItems();
    for (var i = 0; i < map.length; i++) {
        spritePosition[i] = [];
    }

    var screen = $('screen');
    for (var i = 0; i < mapSprites.length; i++) {
        var sprite = mapSprites[i];
        var itemType = itemTypes[sprite.type];
        var img = document.createElement('img');
        img.src = itemType.img;
        img.style.display = "none";
        img.style.position = "absolute";
        img.style.overflow = "hidden";
        sprite.visible = false;
        sprite.block = itemType.block;
        sprite.img = img;
        // stable tie-breaker so objects at nearly the same depth
        // keep a fixed order instead of flickering frame to frame
        sprite.rank = i + 1;
        spritePosition[sprite.y][sprite.x] = sprite;
        sprites.push(sprite);
        screen.appendChild(img);
    }
}

//----------------------------------------------------------

var sprites = [];
var mapSprites = [];
var spritePosition = [];
var itemTypes = [
    { img: 'src/assets/bush.png', block: false },
];

//----------------------------------------------------------

addItems = function () {
    for (var y = 0; y < mapHeight; y++) {
        for (var x = 0; x < mapWidth; x++) {
            var wall = map[y][x];

            if (wall == 0)
                if (Math.random() * 100 < 2) {
                    var item = {
                        type: 0,
                        x: x,
                        y: y
                    }
                    mapSprites.push(item)
                }
        }
    }
}

//----------------------------------------------------------

renderSprites = function () {
    for (var i = 0; i < sprites.length; i++) {

        var sprite = sprites[i];
        var img = sprite.img;

        // visibility is decided by the wall depth buffer:
        // a bush behind a wall is hidden, an uncovered one is shown
        var projection = projectObject(sprite.x + 0.5, sprite.y + 0.5);
        sprite.visible = isObjectVisible(projection);

        if (sprite.visible) {

            img.style.display = "block";

            // x-position on screen
            img.style.left = projection.left + "px";
            // y is constant
            img.style.top = ((screenHeight - projection.size) / 2) + "px";
            img.style.width = projection.size + "px";
            img.style.height = projection.size + "px";

            // fog on sprite, kept based on real distance to player
            img.style.filter = "brightness(" + (100 - 15 * projection.distance) + "%)";
            // layer by actual corrected depth, with a stable tie-breaker
            img.style.zIndex = depthZIndex(projection.depth, sprite.rank);
        } else {
            img.style.display = "none";
        }
    }
}

//----------------------------------------------------------