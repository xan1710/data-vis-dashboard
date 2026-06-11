// Canvas layout
const width = 800;
const height = 400;
const margin = { top: 40, right: 120, bottom: 50, left: 60 };

const tooltip = d3.select("body").append("div")
    .attr("class", "chart-tooltip")
    .attr("id", "chart-tooltip")
    .attr("role", "tooltip")
    .attr("aria-hidden", "true");

function showTooltip(html, x, y, el) {
    tooltip.attr("aria-hidden", "false").style("opacity", 1).html(html)
        .style("left", x + "px").style("top", y + "px");
    if (el) el.setAttribute("aria-describedby", "chart-tooltip");
}

function hideTooltip(el) {
    tooltip.attr("aria-hidden", "true").style("opacity", 0);
    if (el) el.removeAttribute("aria-describedby");
}

function showChartTip(el, html, e) {
    if (e.type === "focus") {
        const r = el.getBoundingClientRect();
        showTooltip(html, r.left + window.scrollX + r.width / 2, r.top + window.scrollY - 15, el);
    } else {
        showTooltip(html, e.pageX + 15, e.pageY - 15);
    }
}

function announceDashboardStatus(tCases, fnCases, mStay) {
    const el = document.getElementById("dashboard-status");
    if (!el) return;
    el.textContent = `${tCases.toLocaleString()} hospitalisations shown. First Nations: ${fnCases.toLocaleString()}. Mean stay: ${mStay.toFixed(1)} days.`;
}

function showAppMessage(text, type) {
    const el = document.getElementById("app-message");
    if (!el) return;
    el.textContent = text;
    el.className = "app-message app-message--" + (type || "error");
    el.hidden = false;
}

function hideAppMessage() {
    const el = document.getElementById("app-message");
    if (el) el.hidden = true;
}

// Animated chart updates when filters change
const CHART_TRANSITION_MS = 650;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let dashboardChartsReady = false;

function chartTransition(selection) {
    return selection.transition().duration(CHART_TRANSITION_MS).ease(d3.easeCubicInOut);
}

function applyTransition(selection, animate) {
    return animate ? chartTransition(selection) : selection;
}

function prepareChart(containerId) {
    const isDashboard = containerId.startsWith("dash-canvas-");
    const parent = d3.select("#" + containerId);
    const svg = parent.select("svg");
    const updating = isDashboard && !svg.empty();
    if (!isDashboard || !updating) parent.html("");
    return { parent, svg, updating };
}

function bindHoverTip(selection, tipFn) {
    return selection
        .on("mouseover focus", function (e, d) { showChartTip(this, tipFn(d), e); })
        .on("mousemove", (e, d) => showTooltip(tipFn(d), e.pageX + 15, e.pageY - 15))
        .on("mouseout blur", function () { hideTooltip(this); });
}

function bindOpacityTip(selection, tipHtml, hoverOpacity, restOpacity) {
    return selection
        .on("mouseover focus", function (e) { d3.select(this).attr("opacity", hoverOpacity); showChartTip(this, tipHtml, e); })
        .on("mousemove", e => showTooltip(tipHtml, e.pageX + 15, e.pageY - 15))
        .on("mouseout blur", function () { d3.select(this).attr("opacity", restOpacity); hideTooltip(this); });
}

function tweenPathY(line, prev, next, key) {
    return () => t => line(prev.map((d, i) => ({ year: d.year, [key]: d[key] + t * (next[i][key] - d[key]) })));
}

function updateDataJoin(svg, cls, data, keyFn, enterFn) {
    const join = svg.selectAll(cls).data(data, keyFn);
    join.exit().remove();
    return enterFn(join.enter()).merge(join);
}

function tweenKpiText(selector, endValue, format) {
    const el = d3.select(selector);
    const node = el.node();
    if (!node) return;
    const parsed = parseFloat(String(node.textContent).replace(/[^\d.-]/g, ""));
    const startValue = Number.isFinite(parsed) ? parsed : 0;
    chartTransition(el).tween("text", () => {
        const i = d3.interpolateNumber(startValue, endValue);
        return t => { node.textContent = format(i(t)); };
    });
}

// Shared constants
const DEFAULT_FILTERS = { gender: "All", year: "All", region: "All", age: "All", roadUser: "All" };
const VEHICLES = ["Car", "Motorcycle", "Bicycle", "Pedestrian", "Truck"];
const COHORTS = ["0-7", "8-16", "17-25", "26-39", "40-64", "65+"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const LINE_YEARS = d3.range(2011, 2022);
const FILTER_SELECTS = ["#global-gender", "#global-year", "#global-region", "#global-age", "#global-roaduser"];
const CHART_DRAWERS = [drawLineChart, drawPyramidChart, drawSpiralChart, drawSankeyChart];
const DASH_IDS = ["dash-canvas-line", "dash-canvas-pyramid", "dash-canvas-spiral", "dash-canvas-bar"];
const LINE_SERIES = [
    { cls: "line-fn", key: "fnIdx", color: "var(--accent-red)", dash: null, width: 3, label: "First Nations", labelOff: 0 },
    { cls: "line-non", key: "nonIdx", color: "var(--chart-blue)", dash: "4,4", width: 2, label: "Non-Indigenous", labelOff: 0 },
    { cls: "line-nat", key: "natIdx", color: "var(--chart-orange)", dash: "4,4", width: 2, label: "National", labelOff: 15 }
];

// Global state
let rawFN = [];
let rawHosp = [];
let dashFilters = { ...DEFAULT_FILTERS };
let activeScrollyStep = 0;
let scrollyNavigating = false;
let scrollySteps = [];

d3.selectAll(".canvas-mount, .dash-card-canvas").each(function () {
    d3.select(this).append("div").attr("class", "chart-loading").attr("role", "status").text("Loading hospitalisation data…");
});

// Load CSV data
Promise.all([
    d3.csv("data/First-Nations-hospitalised-injuries-compiled-raw.csv"),
    d3.csv("data/hospitalisation_injury_publication_sep2023.csv")
]).then(([fnData, hospData]) => {

    const cleanNum = v => +String(v).replace(/,/g, "").replace("n.p.", "0").trim() || 0;

    rawFN = fnData.filter(d => d["Cause of injury = traffic"] === "Traffic").map(d => ({
        year: +d["Calendar year"],
        status: d["First Nations status"].trim(),
        catType: d["Category Type"].trim(),
        catValue: d["Category Value"].trim(),
        cases: cleanNum(d["Hospitalisations"]),
        days: cleanNum(d["Bed days excluding died in hospitals within 30 days"])
    }));

    rawHosp = hospData.filter(d => d["Cause of injury"] === "Traffic").map(d => ({
        year: +d["Calendar year"],
        month: d["Month"].trim(),
        area: d["ABS remoteness area"].trim(),
        sex: d["Sex"].trim(),
        age: d["Age group"].trim(),
        roadUser: d["Road user"].trim(),
        cases: cleanNum(d["Hospitalisations"]),
        days: cleanNum(d["Bed days"])
    }));

    populateYearFilter();

    hideAppMessage();
    d3.selectAll(".chart-loading").remove();
    initScrolly();
    syncScrollyStep(0, false);
    renderDashboard();
}).catch(err => {
    console.error("Error loading data:", err);
    d3.selectAll(".chart-loading").remove();
    showAppMessage("Unable to load hospitalisation data. Please refresh the page or try again later.", "error");
});


// Data helpers
function mapVehicle(ru) {
    const s = String(ru).toLowerCase();
    if (s.includes("pedestrian")) return "Pedestrian";
    if (s.includes("pedal") || s.includes("bicycle")) return "Bicycle";
    if (s.includes("motorcycl")) return "Motorcycle";
    if (s.includes("heavy") || s.includes("bus")) return "Truck";
    if (s.includes("car") || s.includes("pick-up") || s.includes("van") || s.includes("occupant")) return "Car";
    return "Other";
}

function matchAge(dbAge, filterAge) {
    if (filterAge === "All") return true;
    if (!COHORTS.includes(filterAge)) return false;
    if (dbAge === filterAge) return true;
    if (filterAge === "65+" && (dbAge === "65-74" || dbAge === "75+")) return true;
    return false;
}

function populateYearFilter() {
    const years = [...new Set([...rawHosp, ...rawFN].map(d => d.year))].sort((a, b) => b - a);
    const select = d3.select("#global-year");
    const current = select.property("value");
    select.selectAll("option:not([value='All'])").remove();
    years.forEach(y => select.append("option").attr("value", y).text(y));
    if (current !== "All" && years.includes(+current)) select.property("value", current);
}

function filterHospData(fState) {
    return rawHosp.filter(d => {
        if (fState.year !== "All" && d.year !== +fState.year) return false;
        if (fState.gender !== "All" && d.sex.toLowerCase() !== fState.gender.toLowerCase()) return false;
        if (fState.region !== "All" && !d.area.toLowerCase().includes(fState.region.toLowerCase().substring(0, 4))) return false;
        if (fState.roadUser !== "All" && mapVehicle(d.roadUser) !== fState.roadUser) return false;
        if (!matchAge(d.age, fState.age)) return false;
        return true;
    });
}

function hospToCohort(age) {
    if (age === "65-74" || age === "75+") return "65+";
    return COHORTS.includes(age) ? age : null;
}

function sumHospByCohort(rows, cohort) {
    return d3.sum(rows.filter(d => hospToCohort(d.age) === cohort), d => d.cases);
}

// Scale FN age cohorts when gender/region/vehicle filters are active (FN CSV has no those cross-tabs).
function pyramidCohortScale(fState) {
    const yr = fState.year !== "All" ? +fState.year : 2021;
    if (fState.gender === "All" && fState.region === "All" && fState.roadUser === "All") return null;

    const base = rawHosp.filter(d => d.year === yr);
    const filt = filterHospData({ ...fState, year: String(yr), age: "All" });
    return Object.fromEntries(COHORTS.map(c => {
        const b = sumHospByCohort(base, c);
        return [c, b > 0 ? sumHospByCohort(filt, c) / b : 0];
    }));
}

// Dashboard
function renderDashboard() {
    const hospSubset = filterHospData(dashFilters);

    const tCases = d3.sum(hospSubset, d => d.cases);
    const tDays = d3.sum(hospSubset, d => d.days);
    const mStay = tCases > 0 ? (tDays / tCases) : 0;

    let fnBase = rawFN.filter(d => d.catType === "Age group");
    if (dashFilters.year !== "All") fnBase = fnBase.filter(d => d.year === +dashFilters.year);

    if (dashFilters.age !== "All") {
        fnBase = fnBase.filter(d => matchAge(d.catValue, dashFilters.age));
    }

    const fnCases = d3.sum(fnBase.filter(d => d.status === "First Nations people"), d => d.cases);

    const animate = dashboardChartsReady && !prefersReducedMotion;
    [
        ["#kpi-total-cases", tCases, v => Math.round(v).toLocaleString()],
        ["#kpi-fn-cases", fnCases, v => Math.round(v).toLocaleString()],
        ["#kpi-severity-index", mStay, v => v.toFixed(2) + " d"]
    ].forEach(([sel, val, fmt]) => animate ? tweenKpiText(sel, val, fmt) : d3.select(sel).text(fmt(val)));

    DASH_IDS.forEach((id, i) => CHART_DRAWERS[i](id, dashFilters, animate));

    dashboardChartsReady = true;
    announceDashboardStatus(tCases, fnCases, mStay);
}

d3.selectAll(".filter-sidebar select").on("change", function () {
    let id = d3.select(this).attr("id").replace("global-", "");
    if (id === "roaduser") id = "roadUser";
    dashFilters[id] = this.value;
    hideAppMessage();
    renderDashboard();
});

// Export filtered data
document.getElementById("export-csv-btn").addEventListener("click", () => {
    const subset = filterHospData(dashFilters);

    if (subset.length === 0) {
        showAppMessage("No data matches the current filters — nothing to export.", "error");
        return;
    }

    hideAppMessage();

    const csvContent = d3.csvFormat(subset.map(d => ({
        Year: d.year, Month: d.month, Region: d.area, Sex: d.sex,
        "Age Group": d.age, "Road User": d.roadUser,
        Hospitalisations: d.cases, "Bed Days": d.days
    })));

    const parts = ["year", "region", "gender", "age", "roadUser"]
        .filter(k => dashFilters[k] !== "All")
        .map(k => k === "age" ? `age-${dashFilters[k]}` : k === "region" ? dashFilters[k].replace(/\s+/g, "-") : dashFilters[k]);
    const filename = `road-safety-export${parts.length ? "-" + parts.join("-") : ""}.csv`;

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showAppMessage(`Exported ${subset.length.toLocaleString()} rows to ${filename}.`, "success");
});

document.getElementById("reset-filters-btn").addEventListener("click", () => {
    dashFilters = { ...DEFAULT_FILTERS };
    FILTER_SELECTS.forEach(sel => d3.select(sel).property("value", "All"));
    hideAppMessage();
    renderDashboard();
});

// Line chart
function drawLineChart(containerId, fState, animate) {
    const { parent, updating } = prepareChart(containerId);
    let svg = parent.select("svg");

    let subset = rawFN.filter(d => d.catType === "Age group");
    if (fState.age !== "All") subset = subset.filter(d => matchAge(d.catValue, fState.age));

    let data = LINE_YEARS.map(yr => {
        const fn = d3.sum(subset.filter(d => d.year === yr && d.status === "First Nations people"), d => d.cases);
        const non = d3.sum(subset.filter(d => d.year === yr && d.status === "Non-Indigenous"), d => d.cases);
        return { year: yr, fn: fn, non: non, nat: fn + non };
    });

    const baseFn = data[0].fn || 1;
    const baseNon = data[0].non || 1;
    const baseNat = data[0].nat || 1;

    data = data.map(d => ({
        year: d.year,
        fnIdx: baseFn === 0 ? 0 : (d.fn / baseFn) * 100,
        nonIdx: baseNon === 0 ? 0 : (d.non / baseNon) * 100,
        natIdx: baseNat === 0 ? 0 : (d.nat / baseNat) * 100,
        fnRaw: d.fn, nonRaw: d.non, natRaw: d.nat
    }));

    const x = d3.scalePoint().domain(data.map(d => d.year)).range([margin.left, width - margin.right]);

    let maxVal = d3.max(data, d => Math.max(d.fnIdx, d.nonIdx, d.natIdx));
    if (!maxVal || isNaN(maxVal)) maxVal = 100;

    const y = d3.scaleLinear().domain([0, maxVal * 1.15]).range([height - margin.bottom, margin.top]);

    if (!updating) {
        svg = parent.append("svg").attr("viewBox", `0 0 ${width} ${height}`);
        svg.append("title").text("Indexed growth trajectory: First Nations, Non-Indigenous, and National transport injuries over time");
        svg.append("g").attr("transform", `translate(0, ${height - margin.bottom})`).attr("class", "axis axis-x");
        svg.append("g").attr("transform", `translate(${margin.left},0)`).attr("class", "axis axis-y");
        svg.append("g").attr("class", "grid").attr("transform", `translate(${margin.left}, 0)`);
        svg.selectAll(".axis, .grid").attr("aria-hidden", "true");
        LINE_SERIES.forEach(s => {
            const path = svg.append("path").attr("class", s.cls).attr("fill", "none")
                .attr("stroke", s.color).attr("stroke-width", s.width).attr("aria-hidden", "true");
            if (s.dash) path.attr("stroke-dasharray", s.dash);
            svg.append("text").attr("class", `chart-label line-label line-label-${s.cls.slice(5)}`)
                .attr("x", width - margin.right + 10).style("fill", s.color).style("font-weight", "bold")
                .text(s.label).attr("aria-hidden", "true");
        });
    }

    const trans = animate && updating;
    applyTransition(svg.select(".axis-x"), trans).call(d3.axisBottom(x));
    applyTransition(svg.select(".axis-y"), trans).call(d3.axisLeft(y).ticks(6).tickFormat(d => d + "%"));
    applyTransition(svg.select(".grid"), trans).call(d3.axisLeft(y).ticks(6).tickSize(-width + margin.left + margin.right).tickFormat(""));

    const last = data[data.length - 1];
    LINE_SERIES.forEach(s => {
        const line = d3.line().x(d => x(d.year)).y(d => y(d[s.key])).curve(d3.curveMonotoneX);
        const path = svg.select("." + s.cls);
        const prevData = path.datum() || data;
        path.datum(data);
        if (trans) chartTransition(path).attrTween("d", tweenPathY(line, prevData, data, s.key));
        else path.attr("d", line);
        applyTransition(svg.select(`.line-label-${s.cls.slice(5)}`), trans).attr("y", y(last[s.key]) + s.labelOff);
    });

    function lineTip(d) {
        return `<div class="tooltip-title">Year ${d.year} Growth</div>
            <span style="color:var(--accent-red)">First Nations: <b>${d.fnIdx.toFixed(1)}%</b> (${d.fnRaw.toLocaleString()} cases)</span><br>
            <span style="color:var(--chart-blue)">Non-Indigenous: <b>${d.nonIdx.toFixed(1)}%</b> (${d.nonRaw.toLocaleString()} cases)</span><br>
            <span style="color:var(--chart-orange)">National Total: <b>${d.natIdx.toFixed(1)}%</b> (${d.natRaw.toLocaleString()} cases)</span>`;
    }

    const step = x.step();
    const zones = svg.selectAll(".hover-zone").data(data, d => d.year);
    zones.exit().remove();
    const zonesEnter = zones.enter().append("rect").attr("class", "hover-zone")
        .attr("fill", "transparent").style("cursor", "crosshair")
        .attr("tabindex", "0").attr("role", "button");
    const zonesAll = zonesEnter.merge(zones);

    zonesAll
        .attr("aria-label", d =>
            `${d.year}: First Nations ${d.fnIdx.toFixed(1)}% (${d.fnRaw.toLocaleString()} cases), ` +
            `Non-Indigenous ${d.nonIdx.toFixed(1)}% (${d.nonRaw.toLocaleString()} cases), ` +
            `National ${d.natIdx.toFixed(1)}% (${d.natRaw.toLocaleString()} cases)`)
        .on("mouseover focus", function (e, d) {
            const cx = x(d.year);
            svg.append("line").attr("class", "hover-line").attr("aria-hidden", "true")
                .attr("x1", cx).attr("x2", cx).attr("y1", margin.top).attr("y2", height - margin.bottom)
                .attr("stroke", "#94a3b8").attr("stroke-dasharray", "3,3");
            LINE_SERIES.forEach(s => svg.append("circle").attr("class", "hover-dot").attr("aria-hidden", "true")
                .attr("cx", cx).attr("cy", y(d[s.key])).attr("r", 6).attr("fill", s.color).attr("stroke", "#fff").attr("stroke-width", 2));
            showChartTip(this, lineTip(d), e);
        })
        .on("mousemove", (e, d) => showTooltip(lineTip(d), e.pageX + 15, e.pageY - 15))
        .on("mouseout blur", function () {
            svg.selectAll(".hover-line, .hover-dot").remove();
            hideTooltip(this);
        });

    applyTransition(zonesAll, animate && updating)
        .attr("x", d => x(d.year) - step / 2)
        .attr("y", margin.top)
        .attr("width", step)
        .attr("height", height - margin.top - margin.bottom);
}

// Pyramid chart
function drawPyramidChart(containerId, fState, animate) {
    const { parent, updating } = prepareChart(containerId);
    let svg = parent.select("svg");

    const yr = fState.year !== "All" ? +fState.year : 2021;
    const subset = rawFN.filter(d => d.catType === "Age group" && d.year === yr);
    const scale = pyramidCohortScale(fState);

    const data = COHORTS.map(c => {
        const s = scale ? scale[c] : 1;
        return {
            group: c,
            fn: Math.round(d3.sum(subset.filter(d => d.catValue === c && d.status === "First Nations people"), x => x.cases) * s),
            non: Math.round(d3.sum(subset.filter(d => d.catValue === c && d.status === "Non-Indigenous"), x => x.cases) * s)
        };
    });

    const y = d3.scaleBand().domain(COHORTS).range([height - margin.bottom, margin.top]).padding(0.2);
    const xMaxFn = d3.max(data, d => d.fn) || 1;
    const xMaxNon = d3.max(data, d => d.non) || 1;
    const xL = d3.scaleLinear().domain([0, xMaxFn]).range([width / 2 - 35, margin.left]);
    const xR = d3.scaleLinear().domain([0, xMaxNon]).range([width / 2 + 35, width - margin.right]);
    const fnPatternId = "pattern-fn-" + containerId;

    if (!updating) {
        svg = parent.append("svg").attr("viewBox", `0 0 ${width} ${height}`);
        svg.append("title").text("Population pyramid: hospitalisations by age group, First Nations versus Non-Indigenous");
        svg.append("g").attr("transform", `translate(0,${height - margin.bottom})`).attr("class", "axis axis-left");
        svg.append("g").attr("transform", `translate(0,${height - margin.bottom})`).attr("class", "axis axis-right");
        svg.selectAll(".axis").attr("aria-hidden", "true");

        const patternDefs = svg.append("defs");
        const fnPattern = patternDefs.append("pattern")
            .attr("id", fnPatternId).attr("patternUnits", "userSpaceOnUse").attr("width", 6).attr("height", 6);
        fnPattern.append("rect").attr("width", 6).attr("height", 6).attr("fill", "var(--accent-red)");
        fnPattern.append("path").attr("d", "M0,6 L6,0").attr("stroke", "#070a12").attr("stroke-width", 1.2);

        const legend = svg.append("g").attr("class", "pyramid-legend").attr("transform", `translate(${width - margin.right - 100}, ${margin.top - 30})`).attr("aria-hidden", "true");
        legend.append("rect").attr("x", 0).attr("y", 0).attr("width", 10).attr("height", 10).attr("fill", "url(#" + fnPatternId + ")").attr("rx", 2);
        legend.append("text").attr("x", 15).attr("y", 9).style("fill", "var(--text-muted)").attr("class", "chart-label").text("First Nations (striped)");
        legend.append("rect").attr("x", 0).attr("y", 15).attr("width", 10).attr("height", 10).attr("fill", "var(--chart-blue)").attr("rx", 2);
        legend.append("text").attr("x", 15).attr("y", 24).style("fill", "var(--text-muted)").attr("class", "chart-label").text("Non-Indigenous (solid)");
    }

    const trans = animate && updating;
    const mid = width / 2;
    const ageFocus = fState.age !== "All" ? fState.age : null;
    const cohortOpacity = d => !ageFocus || d.group === ageFocus ? 1 : 0.2;

    applyTransition(svg.select(".axis-left"), trans).call(d3.axisBottom(xL).ticks(4).tickFormat(d3.format("~s")));
    applyTransition(svg.select(".axis-right"), trans).call(d3.axisBottom(xR).ticks(4).tickFormat(d3.format("~s")));

    [
        { cls: "lBar", key: "fn", title: "First Nations", fill: "url(#" + fnPatternId + ")", x: d => xL(d.fn), w: d => mid - 35 - xL(d.fn) },
        { cls: "rBar", key: "non", title: "Non-Indigenous", fill: "var(--chart-blue)", x: () => mid + 35, w: d => xR(d.non) - (mid + 35) }
    ].forEach(side => {
        const bars = updateDataJoin(svg, "." + side.cls, data, d => d.group, enter =>
            enter.append("rect").attr("class", "dash-bar " + side.cls).attr("fill", side.fill));
        const tip = d => `<div class="tooltip-title">${side.title} (Age ${d.group})</div>Total: <b>${d[side.key].toLocaleString()}</b> cases`;
        bindHoverTip(bars.attr("tabindex", "0").attr("role", "button")
            .attr("aria-label", d => `${side.title}, age ${d.group}: ${d[side.key].toLocaleString()} hospitalisations`), tip);
        applyTransition(bars, trans)
            .attr("x", side.x).attr("y", d => y(d.group)).attr("width", side.w).attr("height", y.bandwidth())
            .attr("opacity", cohortOpacity);
    });

    const labels = updateDataJoin(svg, ".lbl", data, d => d.group, enter =>
        enter.append("text").attr("class", "chart-label lbl").attr("x", mid)
            .attr("text-anchor", "middle").style("fill", "var(--text-dark)").style("font-weight", "bold").attr("aria-hidden", "true"));
    labels.text(d => d.group);
    applyTransition(labels, trans)
        .attr("y", d => y(d.group) + y.bandwidth() / 2 + 4)
        .attr("opacity", cohortOpacity);
}

// Spiral heatmap
function drawSpiralChart(containerId, fState, animate) {
    const { parent, updating } = prepareChart(containerId);
    let svg = parent.select("svg");

    const subset = filterHospData(fState);
    const gradientId = "spiral-gradient-" + containerId;
    const baseR = 50;
    const rThick = 26;

    const data = VEHICLES.flatMap((v, vIdx) => MONTHS.map((m, mIdx) => ({
        v, vIdx, m, mIdx,
        val: d3.sum(subset.filter(d => mapVehicle(d.roadUser) === v && d.month === m), x => x.cases),
        key: v + "|" + m
    })));

    const maxVal = d3.max(data, d => d.val) || 1;
    const color = d3.scaleSequentialLog(d3.interpolateRgb("#0f172a", "#ef4444")).domain([1, maxVal]);
    const segmentFill = d => d.val === 0 ? "rgba(255,255,255,0.02)" : color(d.val);

    function arcPath(d) {
        const offset = (d.mIdx / 12) * (rThick * 0.85);
        const innerR = baseR + (d.vIdx * rThick) + offset;
        const outerR = innerR + rThick - 1;
        return d3.arc().innerRadius(innerR).outerRadius(outerR)
            .startAngle((d.mIdx * 2 * Math.PI) / 12).endAngle(((d.mIdx + 1) * 2 * Math.PI) / 12)();
    }

    if (!updating) {
        svg = parent.append("svg").attr("viewBox", `0 0 600 600`);
        svg.append("title").text("Spiral heatmap: monthly hospitalisations by vehicle type");
        const g = svg.append("g").attr("class", "spiral-root").attr("transform", `translate(300, 300)`);

        MONTHS.forEach((m, i) => {
            const ang = ((i + 0.5) * 2 * Math.PI) / 12 - Math.PI / 2;
            const radius = baseR + (VEHICLES.length * rThick) + 20;
            g.append("text").attr("class", "chart-label spiral-month-label").attr("x", radius * Math.cos(ang)).attr("y", radius * Math.sin(ang) + 4)
                .attr("text-anchor", "middle").style("fill", "var(--text-muted)").style("font-weight", "bold").text(m.substring(0, 3)).attr("aria-hidden", "true");
        });

        VEHICLES.forEach((v, i) => {
            g.append("text").attr("class", "chart-label spiral-vehicle-label").attr("x", 5).attr("y", -(baseR + (i * rThick) + 12))
                .attr("text-anchor", "start").style("fill", "var(--text-muted)").text(v).attr("aria-hidden", "true");
        });

        const defs = svg.append("defs");
        const gradient = defs.append("linearGradient").attr("id", gradientId).attr("x1", "0%").attr("y1", "0%").attr("x2", "100%").attr("y2", "0%");
        gradient.append("stop").attr("offset", "0%").attr("stop-color", "#0f172a");
        gradient.append("stop").attr("offset", "100%").attr("stop-color", "#ef4444");

        const legendG = g.append("g").attr("class", "spiral-legend").attr("transform", `translate(-100, ${baseR + (VEHICLES.length * rThick) + 40})`).attr("aria-hidden", "true");
        legendG.append("text").attr("x", 100).attr("y", 0).attr("text-anchor", "middle").style("fill", "var(--text-muted)").attr("class", "chart-label").style("font-weight", "bold").text("Hospitalisation Intensity");
        legendG.append("rect").attr("x", 0).attr("y", 8).attr("width", 200).attr("height", 10).style("fill", "url(#" + gradientId + ")");
        legendG.append("text").attr("x", 0).attr("y", 30).attr("text-anchor", "middle").style("fill", "var(--text-muted)").attr("class", "chart-label").text("Low");
        legendG.append("text").attr("x", 200).attr("y", 30).attr("text-anchor", "middle").style("fill", "var(--text-muted)").attr("class", "chart-label").text("High");
    }

    const spiralTip = d => `<div class="tooltip-title">${d.v}</div>Month: ${d.m}<br>Cases: <b>${d.val.toLocaleString()}</b>`;
    const segmentsAll = updateDataJoin(svg.select(".spiral-root"), ".spiral-segment", data, d => d.key, enter =>
        enter.append("path").attr("class", "spiral-segment").attr("d", arcPath)
            .attr("stroke", "var(--panel-bg)").attr("stroke-width", "1.5px")
            .style("cursor", "pointer").attr("tabindex", "0").attr("role", "button"));
    segmentsAll.attr("aria-label", d => `${d.v}, ${d.m}: ${d.val.toLocaleString()} hospitalisations`)
        .on("mouseover focus", function (e, d) { d3.select(this).attr("stroke", "#fff").attr("stroke-width", "2px"); showChartTip(this, spiralTip(d), e); })
        .on("mousemove", (e, d) => showTooltip(spiralTip(d), e.pageX + 15, e.pageY - 15))
        .on("mouseout blur", function () { d3.select(this).attr("stroke", "var(--panel-bg)").attr("stroke-width", "1.5px"); hideTooltip(this); });

    if (animate && updating) {
        segmentsAll.each(function (d) {
            const node = d3.select(this);
            const startVal = (node.datum() || d).val;
            node.datum(d);
            chartTransition(node).attrTween("fill", () => t => {
                const v = startVal + t * (d.val - startVal);
                return v <= 0 ? "rgba(255,255,255,0.02)" : color(Math.max(1, v));
            });
        });
    } else {
        segmentsAll.attr("fill", segmentFill);
    }
}

// Sankey diagram
function drawSankeyChart(containerId, fState, animate) {
    const isDashboard = containerId.startsWith("dash-canvas-");
    const parent = d3.select("#" + containerId);
    const existingSvg = parent.select("svg");
    const updating = isDashboard && !existingSvg.empty();

    if (!isDashboard) {
        parent.html("");
    } else if (updating && animate) {
        chartTransition(existingSvg).style("opacity", 0).on("end", () => {
            parent.html("");
            drawSankeyChart(containerId, fState, false);
            chartTransition(parent.select("svg")).style("opacity", 1);
        });
        return;
    } else {
        parent.html("");
    }

    const W = 860, H = 420;
    const pad = { top: 20, right: 160, bottom: 20, left: 150 };
    const nodeW = 14, nodeGap = 10;

    const svg = parent.append("svg")
        .attr("viewBox", `0 0 ${W} ${H}`)
        .style("overflow", "visible");
    svg.append("title").text("Sankey diagram: trauma flow from region through vehicle type to severity of hospital stay");

    const subset = filterHospData(fState);

    function getSeverity(cases, days) {
        if (!cases) return null;
        const avg = days / cases;
        if (avg < 3) return "Minor Stay (< 3d)";
        if (avg <= 7) return "Moderate Stay (3–7d)";
        return "Severe Stay (> 7d)";
    }

    const agg = {};
    subset.forEach(d => {
        const region = d.area;
        const vehicle = mapVehicle(d.roadUser);
        if (vehicle === "Other" || !region || region === "Missing") return;
        const sev = getSeverity(d.cases, d.days);
        if (!sev) return;
        const k = `${region}||${vehicle}||${sev}`;
        if (!agg[k]) agg[k] = { region, vehicle, sev, cases: 0, days: 0 };
        agg[k].cases += d.cases;
        agg[k].days += d.days;
    });

    const regions = ["Major Cities", "Regional", "Remote"];
    const severities = ["Minor Stay (< 3d)", "Moderate Stay (3–7d)", "Severe Stay (> 7d)"];

    const regionColor = {
        "Major Cities": "var(--chart-blue)",
        "Regional": "var(--chart-orange)",
        "Remote": "var(--accent-red)"
    };
    const vehicleColor = {
        "Car": "#3b82f6",
        "Motorcycle": "#8b5cf6",
        "Bicycle": "#10b981",
        "Pedestrian": "#f59e0b",
        "Truck": "#6b7280"
    };
    const severityColor = {
        "Minor Stay (< 3d)": "var(--chart-blue)",
        "Moderate Stay (3–7d)": "var(--chart-orange)",
        "Severe Stay (> 7d)": "var(--accent-red)"
    };

    const regionTotal = Object.fromEntries(regions.map(r => [r, 0]));
    const vehicleTotal = Object.fromEntries(VEHICLES.map(v => [v, 0]));
    const severityTotal = Object.fromEntries(severities.map(s => [s, 0]));

    Object.values(agg).forEach(({ region, vehicle, sev, cases }) => {
        if (regionTotal[region] !== undefined) regionTotal[region] += cases;
        if (vehicleTotal[vehicle] !== undefined) vehicleTotal[vehicle] += cases;
        if (severityTotal[sev] !== undefined) severityTotal[sev] += cases;
    });

    const totalCases = d3.sum(regions, r => regionTotal[r]);
    if (totalCases === 0) {
        svg.append("text").attr("x", W / 2).attr("y", H / 2)
            .attr("text-anchor", "middle").attr("class", "chart-label")
            .text("No data for current filter selection.");
        return;
    }

    function layoutColumn(names, totals, xPos) {
        const usableH = H - pad.top - pad.bottom;
        const totalGap = nodeGap * (names.length - 1);
        const totalBar = usableH - totalGap;
        let y = pad.top;
        return names
            .filter(n => totals[n] > 0)
            .map(name => {
                const barH = Math.max(2, (totals[name] / totalCases) * totalBar);
                const node = { name, x: xPos, y, h: barH, total: totals[name] };
                y += barH + nodeGap;
                return node;
            });
    }

    const colX1 = pad.left;
    const colX2 = W / 2 - nodeW / 2;
    const colX3 = W - pad.right - nodeW;

    const regionNodes = layoutColumn(regions, regionTotal, colX1);
    const vehicleNodes = layoutColumn(VEHICLES, vehicleTotal, colX2);
    const severityNodes = layoutColumn(severities, severityTotal, colX3);

    const allNodes = [...regionNodes, ...vehicleNodes, ...severityNodes];
    const nodeMap = Object.fromEntries(allNodes.map(n => [n.name, n]));
    const outOffset = Object.fromEntries(allNodes.map(n => [n.name, 0]));
    const inOffset = Object.fromEntries(allNodes.map(n => [n.name, 0]));

    function makeLinks(fromList, toList, fromKey, toKey, colorFn) {
        const links = [];
        fromList.forEach(from => {
            toList.forEach(to => {
                const cases = d3.sum(Object.values(agg).filter(d => d[fromKey] === from && d[toKey] === to), d => d.cases);
                if (!cases) return;
                const source = nodeMap[from], target = nodeMap[to];
                if (!source || !target) return;
                links.push({ source, target, cases, color: colorFn(from, to) });
            });
        });
        return links;
    }

    const rv_links = makeLinks(regions, VEHICLES, "region", "vehicle", r => regionColor[r]);
    const vs_links = makeLinks(VEHICLES, severities, "vehicle", "sev", v => vehicleColor[v]);

    function computeLinkGeometry(links) {
        return links.map(link => {
            const { source: s, target: t, cases } = link;

            const sy0 = s.y + (outOffset[s.name] / s.total) * s.h;
            const sy1 = sy0 + (cases / s.total) * s.h;
            outOffset[s.name] += cases;

            const ty0 = t.y + (inOffset[t.name] / t.total) * t.h;
            const ty1 = ty0 + (cases / t.total) * t.h;
            inOffset[t.name] += cases;

            return { ...link, sy0, sy1, ty0, ty1 };
        });
    }

    const rvGeom = computeLinkGeometry(rv_links);
    const vsGeom = computeLinkGeometry(vs_links);

    function sankeyTip(title, count) {
        const pct = ((count / totalCases) * 100).toFixed(1);
        return `<div class="tooltip-title">${title}</div>Hospitalisations: <b>${count.toLocaleString()}</b><br>Share of total: <b>${pct}%</b>`;
    }

    function drawLinks(links, xSrcRight, xTgtLeft) {
        const g = svg.append("g").attr("class", "sankey-links");
        const cx = (xSrcRight + xTgtLeft) / 2;
        links.forEach(link => {
            const { sy0, sy1, ty0, ty1, color, cases } = link;
            const path = `M ${xSrcRight} ${sy0} C ${cx} ${sy0}, ${cx} ${ty0}, ${xTgtLeft} ${ty0} L ${xTgtLeft} ${ty1} C ${cx} ${ty1}, ${cx} ${sy1}, ${xSrcRight} ${sy1} Z`;
            const title = `${link.source.name} → ${link.target.name}`;
            const pct = ((cases / totalCases) * 100).toFixed(1);
            bindOpacityTip(g.append("path").attr("d", path).attr("fill", color).attr("opacity", 0.25)
                .attr("class", "sankey-link").style("cursor", "pointer")
                .attr("tabindex", "0").attr("role", "button")
                .attr("aria-label", `${link.source.name} to ${link.target.name}: ${cases.toLocaleString()} hospitalisations, ${pct}% of total`),
                sankeyTip(title, cases), 0.65, 0.25);
        });
    }

    drawLinks(rvGeom, colX1 + nodeW, colX2);
    drawLinks(vsGeom, colX2 + nodeW, colX3);

    function drawNodes(nodes, colorMap, labelSide) {
        const anchor = labelSide === "left" ? "end" : labelSide === "right" ? "start" : "middle";
        nodes.forEach(node => {
            const g = svg.append("g").style("cursor", "pointer");
            const pct = ((node.total / totalCases) * 100).toFixed(1);
            const midY = node.y + node.h / 2;
            const textX = labelSide === "left" ? node.x - 8 : labelSide === "right" ? node.x + nodeW + 8 : node.x + nodeW / 2;

            bindOpacityTip(g.append("rect").attr("x", node.x).attr("y", node.y)
                .attr("width", nodeW).attr("height", node.h).attr("fill", colorMap[node.name] || "#94a3b8").attr("rx", 3)
                .attr("tabindex", "0").attr("role", "button")
                .attr("aria-label", `${node.name}: ${node.total.toLocaleString()} hospitalisations, ${pct}% of total`),
                sankeyTip(node.name, node.total), 0.8, 1);

            g.append("text").attr("x", textX).attr("y", midY - 4).attr("text-anchor", anchor).attr("dominant-baseline", "middle")
                .style("fill", "var(--text-dark)").attr("class", "chart-label").style("font-weight", "700")
                .text(node.name).attr("aria-hidden", "true");
            g.append("text").attr("x", textX).attr("y", midY + 10).attr("text-anchor", anchor).attr("dominant-baseline", "middle")
                .style("fill", "var(--text-muted)").attr("class", "chart-label")
                .text(`${(node.total / 1000).toFixed(1)}k · ${pct}%`).attr("aria-hidden", "true");
        });
    }

    [
        [regionNodes, regionColor, "left", "Region", colX1],
        [vehicleNodes, vehicleColor, "right", "Vehicle Type", colX2],
        [severityNodes, severityColor, "right", "Severity of Stay", colX3]
    ].forEach(([nodes, colors, side, label, colX]) => {
        drawNodes(nodes, colors, side);
        svg.append("text").attr("x", colX + nodeW / 2).attr("y", pad.top - 10).attr("text-anchor", "middle")
            .style("fill", "var(--chart-blue)").attr("class", "chart-label")
            .style("font-weight", "800").style("text-transform", "uppercase").style("letter-spacing", "1.5px")
            .text(label).attr("aria-hidden", "true");
    });

    const itemW = 90;
    const legendStartX = colX2 - 4 - Object.keys(vehicleColor).length * itemW / 2 + nodeW / 2;
    Object.entries(vehicleColor).forEach(([name, color], i) => {
        const lx = legendStartX + i * itemW;
        svg.append("rect").attr("x", lx).attr("y", H - 16).attr("width", 10).attr("height", 10)
            .attr("fill", color).attr("rx", 2).attr("aria-hidden", "true");
        svg.append("text").attr("x", lx + 14).attr("y", H - 7)
            .style("fill", "var(--text-muted)").attr("class", "chart-label").text(name).attr("aria-hidden", "true");
    });
}

// Scrollytelling
function updateScrollyChart(index) {
    const draw = CHART_DRAWERS[index];
    if (!draw) return;
    const state = { ...DEFAULT_FILTERS };
    if (index === 1 || index === 2) state.year = "2021";
    draw("chart-canvas", state);
}

function syncScrollyStep(index, announce) {
    if (index < 0 || index >= scrollySteps.length) return;

    activeScrollyStep = index;
    scrollySteps.forEach((s, i) => {
        s.classList.toggle("active", i === index);
        if (i === index) s.setAttribute("aria-current", "step");
        else s.removeAttribute("aria-current");
    });

    if (announce) {
        const status = document.getElementById("scrolly-status");
        const title = scrollySteps[index].querySelector("h2");
        if (status && title) status.textContent = `Section ${index + 1} of ${scrollySteps.length}: ${title.textContent}`;
    }

    updateScrollyChart(index);
}

function jumpScrollyStep(delta) {
    const index = activeScrollyStep + delta;
    if (index < 0 || index >= scrollySteps.length) return;

    scrollyNavigating = true;
    syncScrollyStep(index, true);
    scrollySteps[index].scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => { scrollyNavigating = false; }, 700);
}

function initScrolly() {
    const section = document.querySelector(".scrolly-section");
    if (!section) return;

    scrollySteps = [...document.querySelectorAll(".step")];

    section.addEventListener("keydown", (e) => {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
        if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); jumpScrollyStep(1); }
        if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); jumpScrollyStep(-1); }
    });

    window.addEventListener("scroll", () => {
        if (scrollyNavigating) return;
        let active = 0;
        scrollySteps.forEach((s, i) => { if (s.getBoundingClientRect().top <= window.innerHeight / 2) active = i; });
        if (active !== activeScrollyStep) syncScrollyStep(active, false);
    });
}