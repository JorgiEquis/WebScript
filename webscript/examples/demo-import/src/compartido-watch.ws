server reactive var1 = 0

server function updateVar()
    var1++

watch(var1)
    whisper("Actualizado " + var1)
