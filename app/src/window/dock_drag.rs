//! Arrange mode: the work area's blocks (docks) become cards that drag onto
//! each other. An edge places the dragged dock on that side; the middle swaps.
use super::*;
use super::pane_drag::drop_zone;
use crate::layout::Edge;

pub(super) struct DockDrag {
    dock: String,
    down: Point<Pixels>,
    at: Point<Pixels>,
    moving: bool,
    target: Option<(String, Option<Edge>)>,
}

/// What a dock is called on its card: its title, else what it holds.
fn label(n: &Node) -> String {
    if let Some(t) = n.title.as_ref().filter(|t| !t.trim().is_empty()) {
        return t.clone();
    }
    match &n.kind {
        Kind::Block { content: Content::Context { .. } } => "Terminals".into(),
        Kind::Block { .. } => title_case(&n.id),
        _ => {
            let parts: Vec<String> = n.children().iter().filter(|c| !c.hidden).map(label).collect();
            if parts.is_empty() { title_case(&n.id) } else { parts.join(" · ") }
        }
    }
}

fn title_case(id: &str) -> String {
    id.split(['-', '_']).filter(|w| !w.is_empty()).map(|w| {
        let mut c = w.chars();
        c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
    }).collect::<Vec<_>>().join(" ")
}

fn edge_words(edge: Option<Edge>) -> &'static str {
    match edge {
        Some(Edge::Left) => "Place left of",
        Some(Edge::Right) => "Place right of",
        Some(Edge::Top) => "Place above",
        Some(Edge::Bottom) => "Place below",
        None => "Swap with",
    }
}

impl AppWindow {
    /// Arrange mode needs a personal layout (Zendr's own can't change shape)
    /// with two docks or more.
    pub(super) fn set_arranging(&mut self, on: bool, cx: &mut Context<Self>) -> Result<(), String> {
        if on && shipped_layouts().contains(&self.layout_name.as_str()) {
            return Err(format!("Zendr's own \"{}\" layout can't be rearranged: clone it first (layout.clone).", self.layout_name));
        }
        if on && self.chrome.docks().len() < 2 {
            return Err("Nothing to rearrange: this layout's work area shows one block.".into());
        }
        self.arranging = on;
        self.dock_drag = None;
        cx.notify();
        Ok(())
    }

    fn dock_target(&self, at: Point<Pixels>) -> Option<(String, Option<Edge>)> {
        let d = self.dock_drag.as_ref()?;
        let bounds = self.bounds.borrow();
        self.chrome.docks().into_iter().filter(|n| n.id != d.dock)
            .find_map(|n| Some((n.id.clone(), drop_zone(*bounds.get(&n.id)?, at)?)))
    }

    fn dock_press(&mut self, dock: &str, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.dock_drag = Some(DockDrag { dock: dock.to_owned(), down: at, at, moving: false, target: None });
        cx.notify();
    }

    fn dock_move(&mut self, at: Point<Pixels>, pressed: bool, cx: &mut Context<Self>) {
        let Some(d) = self.dock_drag.as_mut() else { return };
        if !pressed {
            self.dock_drag = None;
            cx.notify();
            return;
        }
        d.at = at;
        if !d.moving && (at.x - d.down.x).abs().max((at.y - d.down.y).abs()) < settings::z(4.) {
            return;
        }
        d.moving = true;
        let target = self.dock_target(at);
        self.dock_drag.as_mut().unwrap().target = target;
        cx.notify();
    }

    fn dock_release(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) -> bool {
        let target = self.dock_target(at);
        let Some(d) = self.dock_drag.take() else { return false };
        if d.moving && let Some((target, edge)) = target && self.chrome.move_dock(&d.dock, &target, edge) {
            self.reset_divider_interaction();
            self.save();
            self.publish(cx);
        }
        cx.notify();
        true
    }

    pub(super) fn cancel_dock_drag(&mut self, cx: &mut Context<Self>) -> bool {
        if self.dock_drag.take().is_some() {
            cx.notify();
            return true;
        }
        if self.arranging {
            self.arranging = false;
            cx.notify();
            return true;
        }
        false
    }

    pub(super) fn arrange_layer(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.arranging {
            return None;
        }
        let bounds = self.bounds.borrow().clone();
        let drag = self.dock_drag.as_ref();
        let dragging = drag.filter(|d| d.moving).map(|d| d.dock.clone());
        let inset = settings::z(6.);
        let cards = self.chrome.docks().into_iter().filter_map(|n| {
            let b = *bounds.get(&n.id)?;
            let id = n.id.clone();
            let lifted = dragging.as_deref() == Some(n.id.as_str());
            let dots = div().flex().flex_col().gap(settings::z(3.)).children((0..2).map(|_| {
                div().flex().gap(settings::z(3.)).children((0..3).map(|_| div().size(settings::z(3.)).rounded_full().bg(c("muted"))))
            }));
            Some(div().id(SharedString::from(format!("dock-card-{}", n.id)))
                .absolute().left(b.origin.x + inset).top(b.origin.y + inset)
                .w((b.size.width - inset * 2.).max(px(0.))).h((b.size.height - inset * 2.).max(px(0.)))
                .rounded(settings::z(10.)).border_2().border_color(c("border"))
                .bg(c("surface").opacity(0.9)).overflow_hidden()
                .flex().flex_col().items_center().justify_center().gap(settings::z(8.))
                .cursor(if dragging.is_some() { CursorStyle::ClosedHand } else { CursorStyle::OpenHand })
                .when(dragging.is_none(), |d| d.hover(|s| s.border_color(c("accent")).bg(c("raised").opacity(0.95))))
                .when(lifted, |d| d.opacity(0.35).border_dashed())
                .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                    this.dock_press(&id, ev.position, cx);
                    cx.stop_propagation();
                }))
                .child(dots)
                .child(div().text_size(settings::z(15.)).font_weight(FontWeight::SEMIBOLD).text_color(c("foreground"))
                    .px(settings::z(12.)).text_center().child(label(n)))
                .child(div().text_size(settings::z(11.)).text_color(c("dim")).child("Drag onto another block"))
                .into_any_element())
        }).collect::<Vec<_>>();
        let preview = drag.and_then(|d| d.target.as_ref()).and_then(|(id, edge)| {
            let mut b = *bounds.get(id)?;
            match edge {
                Some(Edge::Left) => b.size.width /= 2.,
                Some(Edge::Right) => { b.size.width /= 2.; b.origin.x += b.size.width; }
                Some(Edge::Top) => b.size.height /= 2.,
                Some(Edge::Bottom) => { b.size.height /= 2.; b.origin.y += b.size.height; }
                None => {}
            }
            let target = self.chrome.find(id).map(label).unwrap_or_default();
            Some(div().absolute().left(b.origin.x + inset).top(b.origin.y + inset)
                .w((b.size.width - inset * 2.).max(px(0.))).h((b.size.height - inset * 2.).max(px(0.)))
                .rounded(settings::z(10.)).bg(c("accent").opacity(0.2)).border_2().border_color(c("accent"))
                .overflow_hidden().flex().items_center().justify_center().px(settings::z(8.))
                .child(div().min_w_0().px(settings::z(10.)).py(settings::z(5.)).rounded(settings::z(6.)).bg(c("accent"))
                    .text_size(settings::z(12.)).font_weight(FontWeight::SEMIBOLD).text_color(c("background")).truncate()
                    .child(format!("{} {target}", edge_words(*edge))))
                .into_any_element())
        });
        // The block being carried, as a tag at the pointer (left of it near the right edge).
        let right = bounds.get(&self.chrome.id).map(|b| b.origin.x + b.size.width);
        let ghost = drag.filter(|d| d.moving).map(|d| {
            let flip = right.is_some_and(|r| d.at.x > r - settings::z(280.));
            div().absolute().top(d.at.y + settings::z(10.))
                .map(|g| if flip { g.right(right.unwrap() - d.at.x + settings::z(14.)) } else { g.left(d.at.x + settings::z(14.)) })
                .whitespace_nowrap()
                .px(settings::z(10.)).py(settings::z(5.)).rounded(settings::z(6.))
                .bg(c("raised")).border_1().border_color(c("accent")).shadow_md()
                .text_size(settings::z(12.)).text_color(c("foreground"))
                .child(self.chrome.find(&d.dock).map(label).unwrap_or_default())
                .into_any_element()
        });
        let done = div().id("arrange-done").px(settings::z(12.)).py(settings::z(4.)).rounded(settings::z(6.))
            .bg(c("accent")).text_color(c("background")).font_weight(FontWeight::SEMIBOLD).cursor_pointer()
            .hover(|s| s.opacity(0.85))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|this, _, _, cx| { let _ = this.set_arranging(false, cx); }))
            .child("Done");
        let bar = div().absolute().top(settings::z(10.)).left_0().right_0().flex().justify_center()
            .child(div().id("arrange-bar").occlude().flex().items_center().gap(settings::z(12.))
                .pl(settings::z(14.)).pr(settings::z(6.)).py(settings::z(6.)).rounded(settings::z(10.))
                .bg(c("raised")).border_1().border_color(c("border")).shadow_lg()
                .text_size(settings::z(12.)).text_color(c("muted"))
                .child(div().text_color(c("foreground")).font_weight(FontWeight::SEMIBOLD).child("Arrange blocks"))
                .child("Drop on an edge to place it there, in the middle to swap · Esc when done")
                .child(done));
        let this = cx.entity().downgrade();
        Some(div().id("arrange-layer").absolute().inset_0().occlude()
            .bg(c("background").opacity(0.35))
            .when(dragging.is_some(), |d| d.cursor(CursorStyle::ClosedHand))
            .children(cards).children(preview).children(ghost).child(bar)
            .child(canvas(|_, _, _| {}, move |_, _, window, _| {
                let t = this.clone();
                window.on_mouse_event(move |ev: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ = t.update(cx, |this, cx| this.dock_move(ev.position, ev.pressed_button == Some(MouseButton::Left), cx));
                    }
                });
                let t = this.clone();
                window.on_mouse_event(move |ev: &MouseUpEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture && ev.button == MouseButton::Left
                        && t.update(cx, |this, cx| this.dock_release(ev.position, cx)).unwrap_or(false)
                    { cx.stop_propagation(); }
                });
            }).absolute().size_full())
            .into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::{label, title_case};
    use crate::layout::{Axis, Content, Kind, Node};

    #[test]
    fn cards_name_what_the_dock_holds() {
        assert_eq!(title_case("panel-body"), "Panel Body");
        let main = Node::block("main", Content::Context { tab: "active".into(), pane: None });
        assert_eq!(label(&main), "Terminals");
        let mut hub = Node::block("hub", Content::Mod { name: "hub".into(), props: Default::default() });
        hub.title = Some("Hub".into());
        let side = Node::new("side", Kind::Stack { children: vec![hub, Node::container("graph", Axis::Row, vec![])], active: None, header: None });
        assert_eq!(label(&side), "Hub · Graph");
    }
}
