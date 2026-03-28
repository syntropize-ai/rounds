// Feedback aggregator - tracks action adoption signals per service/symptom pair
// and generates LLM context hints to guide future investigations.
export class FeedbackAggregator {
    entries = [];
    /**
     * Record a feedback signal: whether a recommended action for a
     * [serviceId, symptomType] pair was adopted by the operator.
     */
    recordFeedback(serviceId, symptomType, adopted) {
        this.entries.push({
            serviceId,
            symptomType,
            adopted,
            recordedAt: new Date().toISOString(),
        });
    }
    /**
     * Aggregate feedback statistics.
     * Pass a `serviceId` to scope to one service; omit for global stats.
     */
    getStats(serviceId) {
        const scoped = serviceId
            ? this.entries.filter((e) => e.serviceId === serviceId)
            : this.entries;
        const total = scoped.length;
        const adopted = scoped.filter((e) => e.adopted).length;
        const satisfactionRate = total === 0 ? 0 : adopted / total;
        return { total, adopted, satisfactionRate };
    }
    /**
     * Generate an LLM context hint string summarizing past adoption patterns
     * for a given service. Returns null when there is no history yet.
     *
     * The hint is designed to be injected directly into an LLM system prompt
     * to steer future recommendations toward actions operators have found useful.
     */
    getContextHint(serviceId) {
        const scoped = this.entries.filter((e) => e.serviceId === serviceId);
        if (scoped.length === 0) {
            return null;
        }
        const stats = this.getStats(serviceId);
        const bySymptom = new Map();
        for (const e of scoped) {
            const existing = bySymptom.get(e.symptomType) ?? { total: 0, adopted: 0 };
            bySymptom.set(e.symptomType, {
                total: existing.total + 1,
                adopted: existing.adopted + (e.adopted ? 1 : 0),
            });
        }
        const highAdoption = [];
        const lowAdoption = [];
        for (const [symptom, counts] of bySymptom) {
            const rate = counts.adopted / counts.total;
            if (rate >= 0.6) {
                highAdoption.push(symptom);
            }
            else if (rate <= 0.3) {
                lowAdoption.push(symptom);
            }
        }
        const lines = [
            `Past feedback for service "${serviceId}": ${stats.total} signals, ${Math.round(stats.satisfactionRate * 100)}% adoption rate.`,
        ];
        if (highAdoption.length > 0) {
            lines.push(`Operators frequently acted on recommendations for: ${highAdoption.join(', ')}.`);
        }
        if (lowAdoption.length > 0) {
            lines.push(`Operators rarely acted on recommendations for: ${lowAdoption.join(', ')}. Prefer alternative approaches for these symptom types.`);
        }
        return lines.join(' ');
    }
    /** Total number of recorded feedback entries (across all services). */
    get size() {
        return this.entries.length;
    }
}
//# sourceMappingURL=feedback-aggregator.js.map
