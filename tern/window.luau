--!strict
-- Tern side of tern-omp-vimnav: opens the omp thread navigator in the focused pane by typing omp's
-- own shortcut, Alt+K (ESC k).
--
-- In an omp pane, vimnav stands in for Tern's built-in `open_scrollback` ("Open scrollback in
-- editor"): browsing the thread replaces browsing the raw scrollback, so whatever runs that command
-- (its chord, the palette, a menu) opens vimnav. Every other pane keeps the built-in. The palette
-- also gets "vimnav: open thread navigator" (action `plugin.vimnav.open`).
-- Link: tern plugin link <repo>/tern

local function open(cx: WindowCx): boolean
	local pane = cx.session:focused()
	if not pane then
		return false
	end
	cx:run(pane, "\27k")
	return true
end

tern.override("open_scrollback", function(cx: WindowCx): boolean
	local pane = cx.session:focused()
	if not pane then
		return false
	end
	-- A running omp is an agent pane whose surface omp titled "omp". The program is no help (in WSL it is the WSL
	-- launcher), `at_prompt` is true at omp's own prompt, and the surface outlives omp, whose pane then turns back
	-- into a terminal and keeps the built-in.
	local info = cx.session:pane(pane)
	local tree = cx.session:surface(pane, { nodes = 1, depth = 1 })
	if not info or info.kind ~= "agent" or typeof(tree) ~= "table" or tree.surface.title ~= "omp" then
		return false
	end
	return open(cx)
end)

tern.command({
	id = "open",
	title = "vimnav: open thread navigator",
	group = "omp",
	run = function(cx: WindowCx)
		open(cx)
	end,
})
