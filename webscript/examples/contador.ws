reactive contador = 0

style boton =
    -> background-color: blue
    -> color: white
    -> border: none

visual contadorBtn =
<button class={boton} onclick={contador++}>
    Clicks: {contador}
</button>

render(
    contadorBtn
)
