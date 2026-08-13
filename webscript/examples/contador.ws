reactive contador = 0

style boton =
    -> background-color: blue
    -> color: white
    -> border: none

visual contadorBtn =
<button>
    Clicks: {contador}
</button>
    -> style: boton
    -> onclick:
        contador++

render(
    contadorBtn
)
