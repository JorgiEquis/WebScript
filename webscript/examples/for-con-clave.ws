reactive personas = [{ id: 1, nombre: "Ana" }, { id: 2, nombre: "Bea" }, { id: 3, nombre: "Carlos" }]

style boton =
    -> background-color: red
    -> color: white

visual quitarPrimero =
<button>
    Quitar primero
</button>
    -> style: boton
    -> onclick:
        personas = personas.slice(1)

visual lista =
<ul>
    for (p in personas by p.id)
        <li>{p.nombre}</li>
</ul>

visual pagina =
<div>
    <quitarPrimero />
    <lista />
</div>

render(
    pagina
)
