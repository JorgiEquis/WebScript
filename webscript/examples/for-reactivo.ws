reactive lista = ["manzana", "pera"]

style boton =
    -> background-color: green
    -> color: white

visual agregar =
<button>
    Añadir fruta
</button>
    -> style: boton
    -> onclick:
        lista = [...lista, "kiwi"]

visual listaFrutas =
<ul>
    for (fruta in lista)
        <li>{fruta}</li>
</ul>

render(
    agregar,
    listaFrutas
)
