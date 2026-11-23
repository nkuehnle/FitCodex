//! `cargo run --release -p fitledger-ocr --example labels -- screenshot.png [specs.json]` prints the
//! text read from a screenshot, row by row (handy for writing a scale profile's labels), and with a
//! specs file (`[{"field": "pbf", "kind": "pct", "labels": ["Body Fat"]}, ...]`) what it matched.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let image = std::fs::read(&args[0]).expect("image");
    let specs: Vec<fitledger_ocr::labels::LabelSpec> = args.get(1).map(|p| serde_json::from_str(&std::fs::read_to_string(p).expect("specs")).expect("specs json")).unwrap_or_default();
    let dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/models"));
    let r = fitledger_ocr::labels::read_labeled(&image, dir, &specs).unwrap();
    for line in &r.text {
        println!("| {line}");
    }
    println!("date: {:?}", r.measured_at);
    for (k, v) in &r.values {
        println!("{k} = {v} {}", r.units.get(k).map(String::as_str).unwrap_or(""));
    }
}
