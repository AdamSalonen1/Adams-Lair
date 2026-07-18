var innerColumns = document.querySelectorAll('.inner-column');

let counter = 0;

let value = '';

let firstRun = true;

let cellsWon = [[0,0,0],[0,0,0],[0,0,0]];

let cellsWonReference = [];

if(firstRun){
    updateActiveCells('mainContent');
    firstRun = false;
}

async function updateActiveCells(parentDiv){
    let parent = document.getElementById(parentDiv);

    let cells = parent.querySelectorAll('.inner-column');

    var availableCells = new Array();

    cells.forEach((element) => {
        if (element.childElementCount < 1)
        {
            availableCells.push(element);
        }
    })

    //simulating a random opponent button click at this point
    if (counter % 2 != 0) {

        await sleep(1000);

        var min = 0;
        var max = availableCells.length - 1;
        var random = Math.floor(Math.random() * (max - min + 1)) + min;

        var myDiv = availableCells[random];

        myDiv.addEventListener('click', () => clickHandler(myDiv));

        myDiv.click();
    }
    else
    {
        availableCells.forEach((element) => {
            element.addEventListener('click', () => clickHandler(element));
            element.addEventListener('mouseenter', () => mouseEnterHandler(element));
            element.addEventListener('mouseleave', () => mouseLeaveHandler(element));
        })
    }
}

function valueChanged(currentValue){

    //if you just clicked on a cell that will take you to a completed game, just make everything clickable
    if (cellsWonReference.includes(currentValue)){
        currentValue = 'mainContent';
    }

    if(!firstRun){
        let lgCell = document.getElementById(currentValue);

        let old_element = lgCell;
        let new_element = old_element.cloneNode(true);
        old_element.parentNode.replaceChild(new_element, old_element);

        lgCell.style.animation = "flash 1s forwards linear normal";
    }

    let cells = document.querySelectorAll('.inner-column');

    cells.forEach((element) => {
        var old_element = element;
        var new_element = old_element.cloneNode(true);
        old_element.parentNode.replaceChild(new_element, old_element);
    })

    switch(currentValue){
        case 'lg00':
        case 'lg01':
        case 'lg02':
        case 'lg10':
        case 'lg11':
        case 'lg12':
        case 'lg20':
        case 'lg21':
        case 'lg22':
            updateActiveCells(currentValue);
            break;

        default:
            updateActiveCells('mainContent')

    }
}

function clickHandler(element) {
    let image = document.createElement('img');

    if (counter++ % 2 == 0) {
        image.src = 'images/X.png';
        image.id = 'x';
    }
    else {
        image.src = 'images/O.png'
        image.id = 'o';
    }

    image.style.height = '50%';
    image.style.width = '50%';

    element.appendChild(image);

    let newValue = 'lg' + element.getAttribute('id').slice(2);

    element.style.backgroundColor = '';

    checkForWin(element.parentNode.parentNode.id);
    let gameOver = checkArray(cellsWon);

    if (gameOver != '')
    {
        document.getElementById('mainContent').textContent = '';
    }

    valueChanged(newValue);
}

function mouseEnterHandler(element){
    element.style.backgroundColor = '#ff5733';
}

function mouseLeaveHandler(element) {
    element.style.backgroundColor = '';
}

function checkForWin(currentValue){
    let lgCell = document.getElementById(currentValue);
    let cells = lgCell.querySelectorAll('.inner-column');

    const array = [[0,0,0], [0,0,0], [0,0,0]];

    //values we put in when there is an x for calculations
    xVal = 1;
    oVal = 4;

    //fill in the 2d array with values corresponding to an x or an o
    cells.forEach((cell) => {
        if (cell.childElementCount > 0)
        {
            let id = cell.querySelector('img').id
            if (id == 'x')
                array[cell.id.slice(2,3)][cell.id.slice(3)] = xVal;

            else
                array[cell.id.slice(2,3)][cell.id.slice(3)] = oVal;
        }
    });

    let sectionWon = checkArray(array);

    //if a section was won, then add it to the static variables
    if (sectionWon != '')
    {
        let image = document.createElement('img');

        image.src = 'images/' + sectionWon +  '.png';
        image.id = sectionWon;

        image.style.height = '50%';
        image.style.width = '50%';

        lgCell.querySelectorAll('.row').forEach((cell) => {
            lgCell.removeChild(cell);
        });

        lgCell.appendChild(image);

        cellsWonReference.push(currentValue)

        if (sectionWon == 'x')
            cellsWon[lgCell.id.slice(2,3)][lgCell.id.slice(3)] = xVal;
        else if(sectionWon = 'o')
            cellsWon[lgCell.id.slice(2,3)][lgCell.id.slice(3)] = oVal;
    }
}

function checkArray(array)
{
    //just the values multiplied by 3, that signifies a win for non-diagonal wins
    let xMagicNumber = 3;
    let oMagicNumber = 12;

    //check all rows for a win
    let counter = 0;
    for (let i = 0; i < array.length; i++){
        counter = 0;
        for (let j = 0; j < array[i].length; j++){
            if (array[i][j] != 0){
                counter += array[i][j];
            }
            if (counter == xMagicNumber){
                return 'x';
            }
            else if (counter == oMagicNumber){
                return 'o';
            }
        }
    }

    //check all columns for a win
    for (let i = 0; i < array.length; i++){
        counter = 0;
        for (let j = 0; j < array[i].length; j++){
            if (array[j][i] != 0){
                counter += array[j][i];
            }
            if (counter == xMagicNumber){
                return 'x';
            }
            else if (counter == oMagicNumber){
                return 'o';
            }
        }
    }

    //check diagonals for a win
    if (array[1][1] == xVal){
        if ((array[0][0] == xVal && array[2][2] == xVal) || (array[0][2] == xVal && array[2][0] == xVal)){
            return 'x';
        }
    }
    if (array[1][1] == oVal){
        if ((array[0][0] == oVal && array[2][2] == oVal) || (array[0][2] == oVal && array[2][0] == oVal)){
            return 'o';
        }
    }

    return '';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms)); // 2000 milliseconds = 2 seconds
  }
